#import <Foundation/Foundation.h>
#import <CoreML/CoreML.h>
#import <CoreVideo/CoreVideo.h>
#import <Accelerate/Accelerate.h>
#include "realesrgan_coreml.h"
#include <string.h>
#include <stdlib.h>

enum {
    kEsrTile = 512,
    kEsrScale = 4,
    kEsrPad = 8
};

@interface ComicEsrganInput : NSObject <MLFeatureProvider>
@property (nonatomic, assign) CVPixelBufferRef input;
@end

@implementation ComicEsrganInput
- (void)dealloc {
    if (_input) {
        CVPixelBufferRelease(_input);
        _input = nil;
    }
}
- (void)setInput:(CVPixelBufferRef)input {
    if (_input == input) {
        return;
    }
    if (_input) {
        CVPixelBufferRelease(_input);
    }
    _input = input ? (CVPixelBufferRef)CVPixelBufferRetain(input) : nil;
}
- (NSSet<NSString *> *)featureNames {
    return [NSSet setWithObject:@"input"];
}
- (nullable MLFeatureValue *)featureValueForName:(NSString *)featureName {
    if ([featureName isEqualToString:@"input"] && self.input) {
        return [MLFeatureValue featureValueWithPixelBuffer:self.input];
    }
    return nil;
}
@end

static MLModel *g_model = nil;
static NSString *g_loaded_path = nil;
static NSLock *g_lock = nil;
static CVPixelBufferRef g_in0 = NULL;
static CVPixelBufferRef g_in1 = NULL;
static ComicEsrganInput *g_feat0 = nil;
static ComicEsrganInput *g_feat1 = nil;
static unsigned char *g_rgb_tile = NULL;
static dispatch_queue_t g_pred_q = nil;

static void comic_esr_ensure_lock(void) {
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        g_lock = [[NSLock alloc] init];
        g_pred_q = dispatch_queue_create("comic.esrgan.pred", DISPATCH_QUEUE_SERIAL);
    });
}

static int comic_esr_cancelled(const int *flag) {
    return flag && *flag != 0;
}

static CVPixelBufferRef comic_esr_make_pb(void) {
    CVPixelBufferRef pb = NULL;
    NSDictionary *attrs = @{
        (id)kCVPixelBufferIOSurfacePropertiesKey : @{},
        (id)kCVPixelBufferCGImageCompatibilityKey : @YES,
        (id)kCVPixelBufferCGBitmapContextCompatibilityKey : @YES
    };
    CVReturn rc = CVPixelBufferCreate(
        kCFAllocatorDefault,
        kEsrTile,
        kEsrTile,
        kCVPixelFormatType_32BGRA,
        (__bridge CFDictionaryRef)attrs,
        &pb
    );
    return rc == kCVReturnSuccess ? pb : NULL;
}

static int comic_esr_ensure_bufs(void) {
    if (g_in0 && g_in1 && g_feat0 && g_feat1 && g_rgb_tile) {
        return 0;
    }
    if (!g_in0) g_in0 = comic_esr_make_pb();
    if (!g_in1) g_in1 = comic_esr_make_pb();
    if (!g_rgb_tile) g_rgb_tile = (unsigned char *)malloc((size_t)kEsrTile * kEsrTile * 3);
    if (!g_in0 || !g_in1 || !g_rgb_tile) {
        return -5;
    }
    if (!g_feat0) {
        g_feat0 = [[ComicEsrganInput alloc] init];
        g_feat0.input = g_in0;
    }
    if (!g_feat1) {
        g_feat1 = [[ComicEsrganInput alloc] init];
        g_feat1.input = g_in1;
    }
    return 0;
}

static void comic_esr_warmup(MLModel *model) {
    if (!model || comic_esr_ensure_bufs() != 0) {
        return;
    }
    CVPixelBufferLockBaseAddress(g_in0, 0);
    unsigned char *base = (unsigned char *)CVPixelBufferGetBaseAddress(g_in0);
    if (base) {
        memset(base, 128, (size_t)CVPixelBufferGetBytesPerRow(g_in0) * kEsrTile);
    }
    CVPixelBufferUnlockBaseAddress(g_in0, 0);
    NSError *err = nil;
    (void)[model predictionFromFeatures:g_feat0 error:&err];
}

int comic_esrgan_coreml_load(const char *model_path) {
    if (!model_path) {
        return -1;
    }
    comic_esr_ensure_lock();
    [g_lock lock];
    @autoreleasepool {
        NSString *path = [NSString stringWithUTF8String:model_path];
        if (g_model && [g_loaded_path isEqualToString:path]) {
            [g_lock unlock];
            return 0;
        }
        BOOL isDir = NO;
        [[NSFileManager defaultManager] fileExistsAtPath:path isDirectory:&isDir];
        NSError *err = nil;
        NSURL *compiled = nil;
        if (isDir || [path hasSuffix:@".mlmodelc"]) {
            compiled = [NSURL fileURLWithPath:path isDirectory:YES];
        } else {
            NSString *cached = [path stringByAppendingString:@"c"];
            BOOL cacheDir = NO;
            if ([[NSFileManager defaultManager] fileExistsAtPath:cached isDirectory:&cacheDir] && cacheDir) {
                compiled = [NSURL fileURLWithPath:cached isDirectory:YES];
            } else {
                NSURL *url = [NSURL fileURLWithPath:path isDirectory:NO];
                NSURL *tmp = [MLModel compileModelAtURL:url error:&err];
                if (!tmp) {
                    [g_lock unlock];
                    return -2;
                }
                [[NSFileManager defaultManager] removeItemAtPath:cached error:nil];
                if ([[NSFileManager defaultManager] copyItemAtURL:tmp
                                                           toURL:[NSURL fileURLWithPath:cached isDirectory:YES]
                                                           error:&err]) {
                    compiled = [NSURL fileURLWithPath:cached isDirectory:YES];
                } else {
                    compiled = tmp;
                }
            }
        }
        MLModelConfiguration *cfg = [[MLModelConfiguration alloc] init];
        /* On this 512 Image model, All (ANE+GPU) is ~4× faster than CPUAndGPU. */
        cfg.computeUnits = MLComputeUnitsAll;
        if ([cfg respondsToSelector:@selector(setAllowLowPrecisionAccumulationOnGPU:)]) {
            cfg.allowLowPrecisionAccumulationOnGPU = YES;
        }
#ifdef MLSpecializationStrategyFastPrediction
        if (@available(macOS 14.4, *)) {
            cfg.specializationStrategy = MLSpecializationStrategyFastPrediction;
        }
#endif
        g_model = [MLModel modelWithContentsOfURL:compiled configuration:cfg error:&err];
        if (g_model) {
            g_loaded_path = [path copy];
            comic_esr_warmup(g_model);
        }
        [g_lock unlock];
        return g_model ? 0 : -3;
    }
}

static int comic_esr_clamp(int v, int lo, int hi) {
    if (v < lo) return lo;
    if (v > hi) return hi;
    return v;
}

static void comic_esr_fill_tile(
    CVPixelBufferRef pb,
    const unsigned char *rgb,
    int w,
    int h,
    int ox,
    int oy
) {
    /* Gather a 512×512 RGB tile, then one vImage convert to BGRA. */
    for (int y = 0; y < kEsrTile; y++) {
        const int sy = comic_esr_clamp(oy + y, 0, h - 1);
        unsigned char *dst = g_rgb_tile + (size_t)y * kEsrTile * 3;
        if (ox >= 0 && ox + kEsrTile <= w) {
            memcpy(dst, rgb + ((size_t)sy * (size_t)w + (size_t)ox) * 3, (size_t)kEsrTile * 3);
            continue;
        }
        for (int x = 0; x < kEsrTile; x++) {
            const int sx = comic_esr_clamp(ox + x, 0, w - 1);
            memcpy(dst + (size_t)x * 3, rgb + ((size_t)sy * (size_t)w + (size_t)sx) * 3, 3);
        }
    }
    CVPixelBufferLockBaseAddress(pb, 0);
    vImage_Buffer src = {
        .data = g_rgb_tile,
        .height = kEsrTile,
        .width = kEsrTile,
        .rowBytes = (size_t)kEsrTile * 3
    };
    vImage_Buffer dst = {
        .data = CVPixelBufferGetBaseAddress(pb),
        .height = kEsrTile,
        .width = kEsrTile,
        .rowBytes = CVPixelBufferGetBytesPerRow(pb)
    };
    vImageConvert_RGB888toBGRA8888(&src, NULL, 255, &dst, false, kvImageNoFlags);
    CVPixelBufferUnlockBaseAddress(pb, 0);
}

static void comic_esr_blit(
    CVPixelBufferRef src,
    unsigned char *out_rgb,
    int out_w,
    int out_h,
    int dx0,
    int dy0
) {
    CVPixelBufferLockBaseAddress(src, kCVPixelBufferLock_ReadOnly);
    const unsigned char *base = (const unsigned char *)CVPixelBufferGetBaseAddress(src);
    const size_t stride = CVPixelBufferGetBytesPerRow(src);
    const int tw = (int)CVPixelBufferGetWidth(src);
    const int th = (int)CVPixelBufferGetHeight(src);
    const int y0 = dy0 < 0 ? -dy0 : 0;
    const int x0 = dx0 < 0 ? -dx0 : 0;
    const int y1 = (dy0 + th > out_h) ? (out_h - dy0) : th;
    const int x1 = (dx0 + tw > out_w) ? (out_w - dx0) : tw;
    if (x1 <= x0 || y1 <= y0) {
        CVPixelBufferUnlockBaseAddress(src, kCVPixelBufferLock_ReadOnly);
        return;
    }
    const int cw = x1 - x0;
    for (int y = y0; y < y1; y++) {
        const int dy = dy0 + y;
        vImage_Buffer srow = {
            .data = (void *)(base + (size_t)y * stride + (size_t)x0 * 4),
            .height = 1,
            .width = (vImagePixelCount)cw,
            .rowBytes = stride
        };
        vImage_Buffer drow = {
            .data = out_rgb + ((size_t)dy * (size_t)out_w + (size_t)(dx0 + x0)) * 3,
            .height = 1,
            .width = (vImagePixelCount)cw,
            .rowBytes = (size_t)cw * 3
        };
        vImageConvert_BGRA8888toRGB888(&srow, &drow, kvImageNoFlags);
    }
    CVPixelBufferUnlockBaseAddress(src, kCVPixelBufferLock_ReadOnly);
}

static int comic_esr_origins(int w, int h, int **xs, int **ys, int *n_out) {
    const int step = kEsrTile - 2 * kEsrPad;
    int nx = 1;
    int ny = 1;
    if (w > kEsrTile) {
        nx = (w - kEsrTile + step - 1) / step + 1;
    }
    if (h > kEsrTile) {
        ny = (h - kEsrTile + step - 1) / step + 1;
    }
    const int cap = nx * ny;
    int *ox = (int *)malloc((size_t)cap * sizeof(int));
    int *oy = (int *)malloc((size_t)cap * sizeof(int));
    if (!ox || !oy) {
        free(ox);
        free(oy);
        return -1;
    }
    int n = 0;
    for (int j = 0; j < ny; j++) {
        int y = j * step;
        if (y + kEsrTile > h) {
            y = h > kEsrTile ? h - kEsrTile : 0;
        }
        for (int i = 0; i < nx; i++) {
            int x = i * step;
            if (x + kEsrTile > w) {
                x = w > kEsrTile ? w - kEsrTile : 0;
            }
            int dup = 0;
            for (int k = 0; k < n; k++) {
                if (ox[k] == x && oy[k] == y) {
                    dup = 1;
                    break;
                }
            }
            if (dup) {
                continue;
            }
            ox[n] = x;
            oy[n] = y;
            n++;
        }
    }
    *xs = ox;
    *ys = oy;
    *n_out = n;
    return 0;
}

int comic_esrgan_coreml_enhance_rgb(
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
    const int ow = width * kEsrScale;
    const int oh = height * kEsrScale;
    if ((int64_t)ow * (int64_t)oh * 3 > out_cap) {
        return -8;
    }
    if (out_w) *out_w = ow;
    if (out_h) *out_h = oh;
    if (comic_esr_cancelled(cancel_flag)) {
        return -9;
    }

    comic_esr_ensure_lock();
    [g_lock lock];
    MLModel *model = g_model;
    if (!model) {
        [g_lock unlock];
        return -4;
    }
    if (comic_esr_ensure_bufs() != 0) {
        [g_lock unlock];
        return -5;
    }

    int rc = 0;
    @autoreleasepool {
        int *oxs = NULL;
        int *oys = NULL;
        int ntiles = 0;
        if (comic_esr_origins(width, height, &oxs, &oys, &ntiles) != 0 || ntiles <= 0) {
            [g_lock unlock];
            return -1;
        }
        comic_esr_fill_tile(g_in0, rgb, width, height, oxs[0], oys[0]);
        for (int i = 0; i < ntiles; i++) {
            if (comic_esr_cancelled(cancel_flag)) {
                rc = -9;
                break;
            }
            CVPixelBufferRef cur = (i % 2) == 0 ? g_in0 : g_in1;
            ComicEsrganInput *feat = (i % 2) == 0 ? g_feat0 : g_feat1;
            feat.input = cur;
            __block id<MLFeatureProvider> pred = nil;
            __block NSError *err = nil;
            dispatch_semaphore_t sem = dispatch_semaphore_create(0);
            dispatch_async(g_pred_q, ^{
                @autoreleasepool {
                    pred = [model predictionFromFeatures:feat error:&err];
                }
                dispatch_semaphore_signal(sem);
            });
            if (i + 1 < ntiles) {
                CVPixelBufferRef nxt = ((i + 1) % 2) == 0 ? g_in0 : g_in1;
                comic_esr_fill_tile(nxt, rgb, width, height, oxs[i + 1], oys[i + 1]);
            }
            dispatch_semaphore_wait(sem, DISPATCH_TIME_FOREVER);
            if (!pred) {
                rc = -6;
                break;
            }
            MLFeatureValue *fv = [pred featureValueForName:@"activation_out"];
            if (!fv) {
                fv = [pred featureValueForName:@"output"];
            }
            CVPixelBufferRef outb = fv.imageBufferValue;
            if (!outb) {
                rc = -7;
                break;
            }
            comic_esr_blit(outb, out_rgb, ow, oh, oxs[i] * kEsrScale, oys[i] * kEsrScale);
        }
        free(oxs);
        free(oys);
    }
    [g_lock unlock];
    return rc;
}
