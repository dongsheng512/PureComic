#import <Foundation/Foundation.h>
#import <CoreML/CoreML.h>
#import <Accelerate/Accelerate.h>
#include <Availability.h>
#include "animevideo_coreml.h"
#include "coreml_cache.h"
#include <string.h>
#include <stdlib.h>

/* realesr-animevideov3（Compact/SRVGGNet, fp16 mlprogram）。
   张量 I/O 为 [0,1] 域，但 conv/PReLU/最近邻残差均为正齐次，
   宿主直接喂 [0,255] 省两次全图缩放（与 realcugan 同法）。 */
enum {
    kAvdInner = 512,
    kAvdPad = 10,
    kAvdIn = 532,    /* inner + 2*pad */
    kAvdOut = 2048,  /* inner * 4 */
    kAvdScale = 4
};

@interface ComicAvdInput : NSObject <MLFeatureProvider>
@property (nonatomic, strong) MLMultiArray *input;
@end

@implementation ComicAvdInput
- (NSSet<NSString *> *)featureNames {
    return [NSSet setWithObject:@"input"];
}
- (nullable MLFeatureValue *)featureValueForName:(NSString *)featureName {
    if ([featureName isEqualToString:@"input"]) {
        return [MLFeatureValue featureValueWithMultiArray:self.input];
    }
    return nil;
}
@end

static MLModel *g_model = nil;
static NSString *g_loaded_path = nil;
static NSLock *g_lock = nil;
static MLMultiArray *g_in0 = nil;
static MLMultiArray *g_in1 = nil;
static ComicAvdInput *g_feat0 = nil;
static ComicAvdInput *g_feat1 = nil;
static unsigned char *g_rgb_in = NULL;
static unsigned char *g_rgb_out = NULL;
static unsigned char *g_p8_in[3] = { NULL, NULL, NULL };
static unsigned char *g_p8_out[3] = { NULL, NULL, NULL };
static dispatch_queue_t g_pred_q = nil;

static void comic_avd_ensure_lock(void) {
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        g_lock = [[NSLock alloc] init];
        g_pred_q = dispatch_queue_create("comic.animevideo.pred", DISPATCH_QUEUE_SERIAL);
    });
}

static int comic_avd_ensure_inputs(void) {
    if (g_in0 && g_in1 && g_rgb_in && g_rgb_out) {
        return 0;
    }
    NSError *err = nil;
    NSArray<NSNumber *> *shape = @[ @1, @3, @(kAvdIn), @(kAvdIn) ];
    if (!g_in0) {
        g_in0 = [[MLMultiArray alloc] initWithShape:shape dataType:MLMultiArrayDataTypeFloat32 error:&err];
    }
    if (!g_in1) {
        g_in1 = [[MLMultiArray alloc] initWithShape:shape dataType:MLMultiArrayDataTypeFloat32 error:&err];
    }
    if (!g_rgb_in) {
        g_rgb_in = (unsigned char *)malloc((size_t)kAvdIn * kAvdIn * 3);
    }
    if (!g_rgb_out) {
        g_rgb_out = (unsigned char *)malloc((size_t)kAvdOut * kAvdOut * 3);
    }
    for (int i = 0; i < 3; i++) {
        if (!g_p8_in[i]) {
            g_p8_in[i] = (unsigned char *)malloc((size_t)kAvdIn * kAvdIn);
        }
        if (!g_p8_out[i]) {
            g_p8_out[i] = (unsigned char *)malloc((size_t)kAvdOut * kAvdOut);
        }
    }
    if (!g_in0 || !g_in1 || !g_rgb_in || !g_rgb_out ||
        !g_p8_in[0] || !g_p8_in[1] || !g_p8_in[2] ||
        !g_p8_out[0] || !g_p8_out[1] || !g_p8_out[2]) {
        return -5;
    }
    if (!g_feat0) {
        g_feat0 = [[ComicAvdInput alloc] init];
        g_feat0.input = g_in0;
    }
    if (!g_feat1) {
        g_feat1 = [[ComicAvdInput alloc] init];
        g_feat1.input = g_in1;
    }
    return 0;
}

static void comic_avd_warmup(MLModel *model) {
    if (!model || comic_avd_ensure_inputs() != 0) {
        return;
    }
    const NSInteger n = g_in0.count;
    float *p = (float *)g_in0.dataPointer;
    for (NSInteger i = 0; i < n; i++) {
        p[i] = 128.0f;
    }
    NSError *err = nil;
    (void)[model predictionFromFeatures:g_feat0 error:&err];
}

static MLModel *comic_avd_compile_load(NSString *path, NSError **err) {
    NSURL *url = [NSURL fileURLWithPath:path];
    NSString *legacy = [path hasSuffix:@".mlpackage"]
        ? [NSString stringWithFormat:@"%@.i%d.mlmodelc",
                      [path stringByDeletingPathExtension], kAvdIn]
        : [NSString stringWithFormat:@"%@.i%d.c", path, kAvdIn];
    NSString *parent = [[path stringByDeletingLastPathComponent] lastPathComponent];
    NSString *leaf = [NSString stringWithFormat:@"%@_%@", parent, legacy.lastPathComponent];
    BOOL ready = NO;
    NSURL *dest = comic_coreml_cache_destination(legacy, leaf, &ready);
    NSURL *compiled = nil;
    if (ready) {
        compiled = dest;
    } else {
        NSURL *tmp = [MLModel compileModelAtURL:url error:err];
        if (tmp && comic_coreml_store_compiled(tmp, dest)) {
            compiled = dest;
        } else if (tmp) {
            compiled = tmp;
        } else {
            compiled = url;
        }
    }
    MLModelConfiguration *cfg = [[MLModelConfiguration alloc] init];
    cfg.computeUnits = MLComputeUnitsAll;
    if ([cfg respondsToSelector:@selector(setAllowLowPrecisionAccumulationOnGPU:)]) {
        cfg.allowLowPrecisionAccumulationOnGPU = YES;
    }
#if defined(__MAC_OS_X_VERSION_MAX_ALLOWED) && __MAC_OS_X_VERSION_MAX_ALLOWED >= 150000
    if ([[NSProcessInfo processInfo]
            isOperatingSystemAtLeastVersion:(NSOperatingSystemVersion){15, 0, 0}]) {
        MLOptimizationHints *hints = cfg.optimizationHints;
        hints.specializationStrategy = MLSpecializationStrategyFastPrediction;
        cfg.optimizationHints = hints;
    }
#endif
    MLModel *model = [MLModel modelWithContentsOfURL:compiled configuration:cfg error:err];
    if (!model) {
        model = [MLModel modelWithContentsOfURL:url configuration:cfg error:err];
    }
    return model;
}

int comic_animevideo_coreml_load(const char *model_path) {
    if (!model_path) {
        return -1;
    }
    comic_avd_ensure_lock();
    [g_lock lock];
    @autoreleasepool {
        NSString *path = [NSString stringWithUTF8String:model_path];
        if (g_model && [g_loaded_path isEqualToString:path]) {
            [g_lock unlock];
            return 0;
        }
        NSError *err = nil;
        MLModel *model = comic_avd_compile_load(path, &err);
        if (!model) {
            if (err) {
                NSLog(@"animevideo-coreml load failed: %@", err.localizedDescription);
            }
            [g_lock unlock];
            return -3;
        }
        g_model = model;
        g_loaded_path = [path copy];
        comic_avd_warmup(model);
        [g_lock unlock];
        return 0;
    }
}

static int comic_avd_cancelled(const int *flag) {
    return flag && __atomic_load_n(flag, __ATOMIC_ACQUIRE) != 0;
}

static int comic_avd_reflect(int i, int n) {
    if (n <= 1) {
        return 0;
    }
    const int period = 2 * n - 2;
    int x = i % period;
    if (x < 0) {
        x += period;
    }
    if (x >= n) {
        x = period - x;
    }
    return x;
}

static unsigned char *comic_avd_pad_canvas(const unsigned char *rgb, int w, int h, int ph, int pw) {
    const int cw = pw + 2 * kAvdPad;
    const int ch = ph + 2 * kAvdPad;
    unsigned char *canvas = (unsigned char *)malloc((size_t)cw * (size_t)ch * 3);
    if (!canvas) {
        return NULL;
    }
    const int x0 = kAvdPad;
    const int x1 = kAvdPad + w;
    for (int y = 0; y < ch; y++) {
        const int sy = comic_avd_reflect(y - kAvdPad, h);
        const unsigned char *src = rgb + ((size_t)sy * (size_t)w) * 3;
        unsigned char *dst = canvas + ((size_t)y * (size_t)cw) * 3;
        for (int x = 0; x < x0 && x < cw; x++) {
            const int sx = comic_avd_reflect(x - kAvdPad, w);
            memcpy(dst + (size_t)x * 3, src + (size_t)sx * 3, 3);
        }
        if (w > 0 && x0 < cw) {
            const int n = (x1 < cw ? x1 : cw) - x0;
            if (n > 0) {
                memcpy(dst + (size_t)x0 * 3, src, (size_t)n * 3);
            }
        }
        for (int x = x1; x < cw; x++) {
            const int sx = comic_avd_reflect(x - kAvdPad, w);
            memcpy(dst + (size_t)x * 3, src + (size_t)sx * 3, 3);
        }
    }
    return canvas;
}

static void comic_avd_fill_from_canvas(
    MLMultiArray *arr,
    const unsigned char *canvas,
    int cw,
    int ox,
    int oy
) {
    for (int y = 0; y < kAvdIn; y++) {
        memcpy(
            g_rgb_in + (size_t)y * kAvdIn * 3,
            canvas + ((size_t)(oy + y) * (size_t)cw + (size_t)ox) * 3,
            (size_t)kAvdIn * 3
        );
    }
    const NSInteger sc = arr.strides[1].integerValue;
    const NSInteger sh = arr.strides[2].integerValue;
    float *din = (float *)arr.dataPointer;
    vImage_Buffer src = {
        .data = g_rgb_in,
        .height = kAvdIn,
        .width = kAvdIn,
        .rowBytes = (size_t)kAvdIn * 3
    };
    vImage_Buffer r8 = { .data = g_p8_in[0], .height = kAvdIn, .width = kAvdIn, .rowBytes = kAvdIn };
    vImage_Buffer g8 = { .data = g_p8_in[1], .height = kAvdIn, .width = kAvdIn, .rowBytes = kAvdIn };
    vImage_Buffer b8 = { .data = g_p8_in[2], .height = kAvdIn, .width = kAvdIn, .rowBytes = kAvdIn };
    vImageConvert_RGB888toPlanar8(&src, &r8, &g8, &b8, kvImageNoFlags);
    vImage_Buffer pr = {
        .data = din + 0 * sc,
        .height = kAvdIn,
        .width = kAvdIn,
        .rowBytes = (size_t)sh * sizeof(float)
    };
    vImage_Buffer pg = {
        .data = din + 1 * sc,
        .height = kAvdIn,
        .width = kAvdIn,
        .rowBytes = (size_t)sh * sizeof(float)
    };
    vImage_Buffer pb = {
        .data = din + 2 * sc,
        .height = kAvdIn,
        .width = kAvdIn,
        .rowBytes = (size_t)sh * sizeof(float)
    };
    /* [0,255] 域：见文件头注释（正齐次性） */
    vImageConvert_Planar8toPlanarF(&r8, &pr, 1.0f, 0.0f, kvImageNoFlags);
    vImageConvert_Planar8toPlanarF(&g8, &pg, 1.0f, 0.0f, kvImageNoFlags);
    vImageConvert_Planar8toPlanarF(&b8, &pb, 1.0f, 0.0f, kvImageNoFlags);
}

static int comic_avd_copy_out(MLMultiArray *res, unsigned char *rgb888) {
    const int expect = 3 * kAvdOut * kAvdOut;
    if (!res || res.count < expect) {
        return -7;
    }
    if (res.dataType != MLMultiArrayDataTypeFloat32) {
        return -7;
    }
    const NSInteger nd = res.shape.count;
    NSInteger sc;
    NSInteger sh;
    if (nd >= 4) {
        sc = res.strides[1].integerValue;
        sh = res.strides[2].integerValue;
    } else {
        sc = res.strides[0].integerValue;
        sh = res.strides[1].integerValue;
    }
    float *s = (float *)res.dataPointer;
    vImage_Buffer pr = {
        .data = s + 0 * sc,
        .height = kAvdOut,
        .width = kAvdOut,
        .rowBytes = (size_t)sh * sizeof(float)
    };
    vImage_Buffer pg = {
        .data = s + 1 * sc,
        .height = kAvdOut,
        .width = kAvdOut,
        .rowBytes = (size_t)sh * sizeof(float)
    };
    vImage_Buffer pb = {
        .data = s + 2 * sc,
        .height = kAvdOut,
        .width = kAvdOut,
        .rowBytes = (size_t)sh * sizeof(float)
    };
    vImage_Buffer r8 = { .data = g_p8_out[0], .height = kAvdOut, .width = kAvdOut, .rowBytes = kAvdOut };
    vImage_Buffer g8 = { .data = g_p8_out[1], .height = kAvdOut, .width = kAvdOut, .rowBytes = kAvdOut };
    vImage_Buffer b8 = { .data = g_p8_out[2], .height = kAvdOut, .width = kAvdOut, .rowBytes = kAvdOut };
    vImageConvert_PlanarFtoPlanar8(&pr, &r8, 1.0f, 0.0f, kvImageNoFlags);
    vImageConvert_PlanarFtoPlanar8(&pg, &g8, 1.0f, 0.0f, kvImageNoFlags);
    vImageConvert_PlanarFtoPlanar8(&pb, &b8, 1.0f, 0.0f, kvImageNoFlags);
    vImage_Buffer dst = {
        .data = rgb888,
        .height = kAvdOut,
        .width = kAvdOut,
        .rowBytes = (size_t)kAvdOut * 3
    };
    vImageConvert_Planar8toRGB888(&r8, &g8, &b8, &dst, kvImageNoFlags);
    return 0;
}

static void comic_avd_blit_rgb(
    const unsigned char *tile,
    unsigned char *out_rgb,
    int out_w,
    int out_h,
    int dx0,
    int dy0
) {
    for (int y = 0; y < kAvdOut; y++) {
        const int dy = dy0 + y;
        if (dy < 0 || dy >= out_h) {
            continue;
        }
        int x0 = dx0 < 0 ? -dx0 : 0;
        int x1 = dx0 + kAvdOut > out_w ? (out_w - dx0) : kAvdOut;
        if (x1 <= x0) {
            continue;
        }
        memcpy(
            out_rgb + ((size_t)dy * (size_t)out_w + (size_t)(dx0 + x0)) * 3,
            tile + ((size_t)y * kAvdOut + (size_t)x0) * 3,
            (size_t)(x1 - x0) * 3
        );
    }
}

int comic_animevideo_coreml_enhance_rgb(
    const unsigned char *rgb,
    int width,
    int height,
    unsigned char *out_rgb,
    int out_cap,
    int *out_w,
    int *out_h,
    const int *cancel_flag
) {
    if (!rgb || !out_rgb || width <= 0 || height <= 0) {
        return -1;
    }
    const int ow = width * kAvdScale;
    const int oh = height * kAvdScale;
    if ((int64_t)ow * (int64_t)oh * 3 > out_cap) {
        return -8;
    }
    if (out_w) *out_w = ow;
    if (out_h) *out_h = oh;
    if (comic_avd_cancelled(cancel_flag)) {
        return -9;
    }

    comic_avd_ensure_lock();
    [g_lock lock];
    MLModel *model = g_model;
    if (!model) {
        [g_lock unlock];
        return -4;
    }
    if (comic_avd_ensure_inputs() != 0) {
        [g_lock unlock];
        return -5;
    }

    int rc = 0;
    @autoreleasepool {
        const int nx = (width + kAvdInner - 1) / kAvdInner;
        const int ny = (height + kAvdInner - 1) / kAvdInner;
        const int ntiles = nx * ny;
        const int pw = nx * kAvdInner;
        const int ph = ny * kAvdInner;
        if (ntiles <= 0) {
            [g_lock unlock];
            return -1;
        }
        unsigned char *canvas = comic_avd_pad_canvas(rgb, width, height, ph, pw);
        if (!canvas) {
            [g_lock unlock];
            return -1;
        }
        const int cw = pw + 2 * kAvdPad;

        comic_avd_fill_from_canvas(g_in0, canvas, cw, 0, 0);
        for (int t = 0; t < ntiles; t++) {
            if (comic_avd_cancelled(cancel_flag)) {
                rc = -9;
                break;
            }
            const int tx = t % nx;
            const int ty = t / nx;
            MLMultiArray *cur_in = (t % 2) == 0 ? g_in0 : g_in1;
            ComicAvdInput *feat = (t % 2) == 0 ? g_feat0 : g_feat1;
            feat.input = cur_in;
            __block id<MLFeatureProvider> pred = nil;
            __block NSError *err = nil;
            dispatch_semaphore_t sem = dispatch_semaphore_create(0);
            dispatch_async(g_pred_q, ^{
                @autoreleasepool {
                    pred = [model predictionFromFeatures:feat error:&err];
                }
                dispatch_semaphore_signal(sem);
            });
            if (t + 1 < ntiles) {
                const int ntx = (t + 1) % nx;
                const int nty = (t + 1) / nx;
                MLMultiArray *nxt = ((t + 1) % 2) == 0 ? g_in0 : g_in1;
                comic_avd_fill_from_canvas(nxt, canvas, cw, ntx * kAvdInner, nty * kAvdInner);
            }
            dispatch_semaphore_wait(sem, DISPATCH_TIME_FOREVER);
            if (!pred) {
                if (err) {
                    NSLog(@"animevideo-coreml predict failed: %@", err.localizedDescription);
                }
                rc = -6;
                break;
            }
            MLFeatureValue *fv = [pred featureValueForName:@"output"];
            if (!fv) {
                fv = [pred featureValueForName:@"input"];
            }
            if (comic_avd_copy_out(fv.multiArrayValue, g_rgb_out) != 0) {
                rc = -7;
                break;
            }
            comic_avd_blit_rgb(
                g_rgb_out,
                out_rgb,
                ow,
                oh,
                tx * kAvdInner * kAvdScale,
                ty * kAvdInner * kAvdScale
            );
        }
        free(canvas);
    }
    [g_lock unlock];
    return rc;
}
