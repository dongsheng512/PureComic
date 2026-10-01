#import <Foundation/Foundation.h>
#import <CoreML/CoreML.h>
#import <Accelerate/Accelerate.h>
#include <Availability.h>
#include "realcugan_coreml.h"
#include "coreml_cache.h"
#include <string.h>
#include <stdlib.h>
#include <math.h>

enum {
    kCugInner = 384,
    kCugPad = 18,
    kCugIn = 420,   /* inner + 2*pad */
    kCugOut = 768,  /* inner * 2 */
    kCugScale = 2,
    kCugMaxModels = 4
};

@interface ComicCuganInput : NSObject <MLFeatureProvider>
@property (nonatomic, strong) MLMultiArray *input;
@end

@implementation ComicCuganInput
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

static MLModel *g_slots[kCugMaxModels];
static NSString *g_slot_paths[kCugMaxModels];
static int g_nslots = 0;
static MLModel *g_model = nil;
static NSString *g_loaded_path = nil;
static NSLock *g_lock = nil;
static MLMultiArray *g_in0 = nil;
static MLMultiArray *g_in1 = nil;
static ComicCuganInput *g_feat0 = nil;
static ComicCuganInput *g_feat1 = nil;
static unsigned char *g_rgb_in = NULL;
static unsigned char *g_rgb_out = NULL;
static unsigned char *g_p8_in[3] = { NULL, NULL, NULL };
static unsigned char *g_p8_out[3] = { NULL, NULL, NULL };
static dispatch_queue_t g_pred_q = nil;

static void comic_cug_ensure_lock(void) {
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        g_lock = [[NSLock alloc] init];
        g_pred_q = dispatch_queue_create("comic.realcugan.pred", DISPATCH_QUEUE_SERIAL);
    });
}

static int comic_cug_ensure_inputs(void) {
    if (g_in0 && g_in1 && g_rgb_in && g_rgb_out) {
        return 0;
    }
    NSError *err = nil;
    NSArray<NSNumber *> *shape = @[ @1, @3, @(kCugIn), @(kCugIn) ];
    if (!g_in0) {
        g_in0 = [[MLMultiArray alloc] initWithShape:shape dataType:MLMultiArrayDataTypeFloat32 error:&err];
    }
    if (!g_in1) {
        g_in1 = [[MLMultiArray alloc] initWithShape:shape dataType:MLMultiArrayDataTypeFloat32 error:&err];
    }
    if (!g_rgb_in) {
        g_rgb_in = (unsigned char *)malloc((size_t)kCugIn * kCugIn * 3);
    }
    if (!g_rgb_out) {
        g_rgb_out = (unsigned char *)malloc((size_t)kCugOut * kCugOut * 3);
    }
    for (int i = 0; i < 3; i++) {
        if (!g_p8_in[i]) {
            g_p8_in[i] = (unsigned char *)malloc((size_t)kCugIn * kCugIn);
        }
        if (!g_p8_out[i]) {
            g_p8_out[i] = (unsigned char *)malloc((size_t)kCugOut * kCugOut);
        }
    }
    if (!g_in0 || !g_in1 || !g_rgb_in || !g_rgb_out ||
        !g_p8_in[0] || !g_p8_in[1] || !g_p8_in[2] ||
        !g_p8_out[0] || !g_p8_out[1] || !g_p8_out[2]) {
        return -5;
    }
    if (!g_feat0) {
        g_feat0 = [[ComicCuganInput alloc] init];
        g_feat0.input = g_in0;
    }
    if (!g_feat1) {
        g_feat1 = [[ComicCuganInput alloc] init];
        g_feat1.input = g_in1;
    }
    return 0;
}

static void comic_cug_warmup(MLModel *model) {
    if (!model || comic_cug_ensure_inputs() != 0) {
        return;
    }
    const NSInteger n = g_in0.count;
    float *p = (float *)g_in0.dataPointer;
    for (NSInteger i = 0; i < n; i++) {
        p[i] = 0.5f;
    }
    NSError *err = nil;
    (void)[model predictionFromFeatures:g_feat0 error:&err];
}

static MLModel *comic_cug_compile_load(NSString *path, NSError **err) {
    NSURL *url = [NSURL fileURLWithPath:path];
    NSString *legacy = [path hasSuffix:@".mlpackage"]
        ? [NSString stringWithFormat:@"%@.i%d.mlmodelc",
                      [path stringByDeletingPathExtension], kCugIn]
        : [NSString stringWithFormat:@"%@.i%d.c", path, kCugIn];
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

int comic_cugan_coreml_load(const char *model_path) {
    if (!model_path) {
        return -1;
    }
    comic_cug_ensure_lock();
    [g_lock lock];
    @autoreleasepool {
        NSString *path = [NSString stringWithUTF8String:model_path];
        for (int i = 0; i < g_nslots; i++) {
            if (g_slots[i] && [g_slot_paths[i] isEqualToString:path]) {
                g_model = g_slots[i];
                g_loaded_path = g_slot_paths[i];
                [g_lock unlock];
                return 0;
            }
        }
        NSError *err = nil;
        MLModel *model = comic_cug_compile_load(path, &err);
        if (!model) {
            if (err) {
                NSLog(@"realcugan-coreml load failed: %@", err.localizedDescription);
            }
            [g_lock unlock];
            return -3;
        }
        int slot;
        if (g_nslots < kCugMaxModels) {
            slot = g_nslots++;
        } else {
            slot = 0;
            for (int i = 1; i < kCugMaxModels; i++) {
                if (![g_slot_paths[i] isEqualToString:g_loaded_path]) {
                    slot = i;
                    break;
                }
            }
        }
        g_slots[slot] = model;
        g_slot_paths[slot] = [path copy];
        g_model = model;
        g_loaded_path = g_slot_paths[slot];
        comic_cug_warmup(model);
        [g_lock unlock];
        return 0;
    }
}

static int comic_cug_cancelled(const int *flag) {
    return flag && __atomic_load_n(flag, __ATOMIC_ACQUIRE) != 0;
}

static int comic_cug_reflect(int i, int n) {
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

static unsigned char *comic_cug_pad_canvas(const unsigned char *rgb, int w, int h, int ph, int pw) {
    const int cw = pw + 2 * kCugPad;
    const int ch = ph + 2 * kCugPad;
    unsigned char *canvas = (unsigned char *)malloc((size_t)cw * (size_t)ch * 3);
    if (!canvas) {
        return NULL;
    }
    /* Interior x maps 1:1 onto the source row. Only the pad and the
       tile-grid overhang need reflect. */
    const int x0 = kCugPad;
    const int x1 = kCugPad + w;
    for (int y = 0; y < ch; y++) {
        const int sy = comic_cug_reflect(y - kCugPad, h);
        const unsigned char *src = rgb + ((size_t)sy * (size_t)w) * 3;
        unsigned char *dst = canvas + ((size_t)y * (size_t)cw) * 3;
        for (int x = 0; x < x0 && x < cw; x++) {
            const int sx = comic_cug_reflect(x - kCugPad, w);
            memcpy(dst + (size_t)x * 3, src + (size_t)sx * 3, 3);
        }
        if (w > 0 && x0 < cw) {
            const int n = (x1 < cw ? x1 : cw) - x0;
            if (n > 0) {
                memcpy(dst + (size_t)x0 * 3, src, (size_t)n * 3);
            }
        }
        for (int x = x1; x < cw; x++) {
            const int sx = comic_cug_reflect(x - kCugPad, w);
            memcpy(dst + (size_t)x * 3, src + (size_t)sx * 3, 3);
        }
    }
    return canvas;
}

static void comic_cug_fill_from_canvas(
    MLMultiArray *arr,
    const unsigned char *canvas,
    int cw,
    int ox,
    int oy
) {
    for (int y = 0; y < kCugIn; y++) {
        memcpy(
            g_rgb_in + (size_t)y * kCugIn * 3,
            canvas + ((size_t)(oy + y) * (size_t)cw + (size_t)ox) * 3,
            (size_t)kCugIn * 3
        );
    }
    const NSInteger sc = arr.strides[1].integerValue;
    const NSInteger sh = arr.strides[2].integerValue;
    float *din = (float *)arr.dataPointer;
    vImage_Buffer src = {
        .data = g_rgb_in,
        .height = kCugIn,
        .width = kCugIn,
        .rowBytes = (size_t)kCugIn * 3
    };
    vImage_Buffer r8 = { .data = g_p8_in[0], .height = kCugIn, .width = kCugIn, .rowBytes = kCugIn };
    vImage_Buffer g8 = { .data = g_p8_in[1], .height = kCugIn, .width = kCugIn, .rowBytes = kCugIn };
    vImage_Buffer b8 = { .data = g_p8_in[2], .height = kCugIn, .width = kCugIn, .rowBytes = kCugIn };
    vImageConvert_RGB888toPlanar8(&src, &r8, &g8, &b8, kvImageNoFlags);
    vImage_Buffer pr = {
        .data = din + 0 * sc,
        .height = kCugIn,
        .width = kCugIn,
        .rowBytes = (size_t)sh * sizeof(float)
    };
    vImage_Buffer pg = {
        .data = din + 1 * sc,
        .height = kCugIn,
        .width = kCugIn,
        .rowBytes = (size_t)sh * sizeof(float)
    };
    vImage_Buffer pb = {
        .data = din + 2 * sc,
        .height = kCugIn,
        .width = kCugIn,
        .rowBytes = (size_t)sh * sizeof(float)
    };
    vImageConvert_Planar8toPlanarF(&r8, &pr, 1.0f, 0.0f, kvImageNoFlags);
    vImageConvert_Planar8toPlanarF(&g8, &pg, 1.0f, 0.0f, kvImageNoFlags);
    vImageConvert_Planar8toPlanarF(&b8, &pb, 1.0f, 0.0f, kvImageNoFlags);
}

static int comic_cug_copy_out(MLMultiArray *res, unsigned char *rgb888) {
    const int expect = 3 * kCugOut * kCugOut;
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
        .height = kCugOut,
        .width = kCugOut,
        .rowBytes = (size_t)sh * sizeof(float)
    };
    vImage_Buffer pg = {
        .data = s + 1 * sc,
        .height = kCugOut,
        .width = kCugOut,
        .rowBytes = (size_t)sh * sizeof(float)
    };
    vImage_Buffer pb = {
        .data = s + 2 * sc,
        .height = kCugOut,
        .width = kCugOut,
        .rowBytes = (size_t)sh * sizeof(float)
    };
    vImage_Buffer r8 = { .data = g_p8_out[0], .height = kCugOut, .width = kCugOut, .rowBytes = kCugOut };
    vImage_Buffer g8 = { .data = g_p8_out[1], .height = kCugOut, .width = kCugOut, .rowBytes = kCugOut };
    vImage_Buffer b8 = { .data = g_p8_out[2], .height = kCugOut, .width = kCugOut, .rowBytes = kCugOut };
    vImageConvert_PlanarFtoPlanar8(&pr, &r8, 1.0f, 0.0f, kvImageNoFlags);
    vImageConvert_PlanarFtoPlanar8(&pg, &g8, 1.0f, 0.0f, kvImageNoFlags);
    vImageConvert_PlanarFtoPlanar8(&pb, &b8, 1.0f, 0.0f, kvImageNoFlags);
    vImage_Buffer dst = {
        .data = rgb888,
        .height = kCugOut,
        .width = kCugOut,
        .rowBytes = (size_t)kCugOut * 3
    };
    vImageConvert_Planar8toRGB888(&r8, &g8, &b8, &dst, kvImageNoFlags);
    return 0;
}

static void comic_cug_blit_rgb(
    const unsigned char *tile,
    unsigned char *out_rgb,
    int out_w,
    int out_h,
    int dx0,
    int dy0
) {
    for (int y = 0; y < kCugOut; y++) {
        const int dy = dy0 + y;
        if (dy < 0 || dy >= out_h) {
            continue;
        }
        int x0 = dx0 < 0 ? -dx0 : 0;
        int x1 = dx0 + kCugOut > out_w ? (out_w - dx0) : kCugOut;
        if (x1 <= x0) {
            continue;
        }
        memcpy(
            out_rgb + ((size_t)dy * (size_t)out_w + (size_t)(dx0 + x0)) * 3,
            tile + ((size_t)y * kCugOut + (size_t)x0) * 3,
            (size_t)(x1 - x0) * 3
        );
    }
}

int comic_cugan_coreml_enhance_rgb(
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
    const int ow = width * kCugScale;
    const int oh = height * kCugScale;
    if ((int64_t)ow * (int64_t)oh * 3 > out_cap) {
        return -8;
    }
    if (out_w) *out_w = ow;
    if (out_h) *out_h = oh;
    if (comic_cug_cancelled(cancel_flag)) {
        return -9;
    }

    comic_cug_ensure_lock();
    [g_lock lock];
    MLModel *model = g_model;
    if (!model) {
        [g_lock unlock];
        return -4;
    }
    if (comic_cug_ensure_inputs() != 0) {
        [g_lock unlock];
        return -5;
    }

    int rc = 0;
    @autoreleasepool {
        const int nx = (width + kCugInner - 1) / kCugInner;
        const int ny = (height + kCugInner - 1) / kCugInner;
        const int ntiles = nx * ny;
        const int pw = nx * kCugInner;
        const int ph = ny * kCugInner;
        if (ntiles <= 0) {
            [g_lock unlock];
            return -1;
        }
        unsigned char *canvas = comic_cug_pad_canvas(rgb, width, height, ph, pw);
        if (!canvas) {
            [g_lock unlock];
            return -1;
        }
        const int cw = pw + 2 * kCugPad;

        /* 填下一块、贴上一块都和当前预测重叠。输入缓冲乒乓，同一时刻只有一块在预测。 */
        comic_cug_fill_from_canvas(g_in0, canvas, cw, 0, 0);
        __block id<MLFeatureProvider> pred = nil;
        __block NSError *err = nil;
        dispatch_semaphore_t sem = dispatch_semaphore_create(0);
        {
            g_feat0.input = g_in0;
            ComicCuganInput *feat = g_feat0;
            dispatch_async(g_pred_q, ^{
                @autoreleasepool {
                    pred = [model predictionFromFeatures:feat error:&err];
                }
                dispatch_semaphore_signal(sem);
            });
        }
        for (int t = 0; t < ntiles; t++) {
            if (comic_cug_cancelled(cancel_flag)) {
                dispatch_semaphore_wait(sem, DISPATCH_TIME_FOREVER);
                rc = -9;
                break;
            }
            if (t + 1 < ntiles) {
                const int ntx = (t + 1) % nx;
                const int nty = (t + 1) / nx;
                MLMultiArray *nxt = ((t + 1) % 2) == 0 ? g_in0 : g_in1;
                comic_cug_fill_from_canvas(nxt, canvas, cw, ntx * kCugInner, nty * kCugInner);
            }
            dispatch_semaphore_wait(sem, DISPATCH_TIME_FOREVER);
            id<MLFeatureProvider> done = pred;
            NSError *doneErr = err;
            pred = nil;
            err = nil;
            const int tx = t % nx;
            const int ty = t / nx;
            BOOL kicked = NO;
            if (t + 1 < ntiles && done) {
                sem = dispatch_semaphore_create(0);
                MLMultiArray *nxtIn = ((t + 1) % 2) == 0 ? g_in0 : g_in1;
                ComicCuganInput *feat = ((t + 1) % 2) == 0 ? g_feat0 : g_feat1;
                feat.input = nxtIn;
                dispatch_async(g_pred_q, ^{
                    @autoreleasepool {
                        pred = [model predictionFromFeatures:feat error:&err];
                    }
                    dispatch_semaphore_signal(sem);
                });
                kicked = YES;
            }
            if (!done) {
                if (doneErr) {
                    NSLog(@"realcugan-coreml predict failed: %@", doneErr.localizedDescription);
                }
                rc = -6;
                break;
            }
            MLFeatureValue *fv = [done featureValueForName:@"output"];
            if (!fv) {
                fv = [done featureValueForName:@"input"];
            }
            if (comic_cug_copy_out(fv.multiArrayValue, g_rgb_out) != 0) {
                if (kicked) {
                    dispatch_semaphore_wait(sem, DISPATCH_TIME_FOREVER);
                }
                rc = -7;
                break;
            }
            comic_cug_blit_rgb(
                g_rgb_out,
                out_rgb,
                ow,
                oh,
                tx * kCugInner * kCugScale,
                ty * kCugInner * kCugScale
            );
        }
        free(canvas);
    }
    [g_lock unlock];
    return rc;
}
