#import <Foundation/Foundation.h>
#import <CoreML/CoreML.h>
#include "waifu2x_coreml.h"
#include <string.h>
#include <stdlib.h>
#include <math.h>

enum {
    kW2xBlock = 142,
    kW2xShrink = 7,
    kW2xScale = 2,
    kW2xIn = 156,  /* block + 2*shrink */
    kW2xOut = 284  /* block * scale */
};

static const double kClipEta8 = 0.00196078411;

@interface ComicW2xInput : NSObject <MLFeatureProvider>
@property (nonatomic, strong) MLMultiArray *input;
@end

@implementation ComicW2xInput
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
static ComicW2xInput *g_feat0 = nil;
static ComicW2xInput *g_feat1 = nil;
static dispatch_queue_t g_pred_q = nil;

static void comic_w2x_ensure_lock(void) {
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        g_lock = [[NSLock alloc] init];
        g_pred_q = dispatch_queue_create("comic.waifu2x.pred", DISPATCH_QUEUE_SERIAL);
    });
}

static int comic_w2x_ensure_inputs(void) {
    if (g_in0 && g_in1) {
        return 0;
    }
    NSError *err = nil;
    NSArray<NSNumber *> *shape = @[ @3, @(kW2xIn), @(kW2xIn) ];
    g_in0 = [[MLMultiArray alloc] initWithShape:shape dataType:MLMultiArrayDataTypeDouble error:&err];
    g_in1 = [[MLMultiArray alloc] initWithShape:shape dataType:MLMultiArrayDataTypeDouble error:&err];
    if (!g_in0 || !g_in1) {
        g_in0 = nil;
        g_in1 = nil;
        return -5;
    }
    g_feat0 = [[ComicW2xInput alloc] init];
    g_feat0.input = g_in0;
    g_feat1 = [[ComicW2xInput alloc] init];
    g_feat1.input = g_in1;
    return 0;
}

int comic_w2x_coreml_load(const char *model_path) {
    if (!model_path) {
        return -1;
    }
    comic_w2x_ensure_lock();
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
                if ([[NSFileManager defaultManager] copyItemAtURL:tmp toURL:[NSURL fileURLWithPath:cached isDirectory:YES] error:&err]) {
                    compiled = [NSURL fileURLWithPath:cached isDirectory:YES];
                } else {
                    compiled = tmp;
                }
            }
        }
        MLModelConfiguration *cfg = [[MLModelConfiguration alloc] init];
        cfg.computeUnits = MLComputeUnitsAll;
        g_model = [MLModel modelWithContentsOfURL:compiled configuration:cfg error:&err];
        if (g_model) {
            g_loaded_path = [path copy];
            g_in0 = nil;
            g_in1 = nil;
            g_feat0 = nil;
            g_feat1 = nil;
        }
        [g_lock unlock];
        return g_model ? 0 : -3;
    }
}

static int comic_w2x_cancelled(const int *flag) {
    return flag && *flag != 0;
}

static void comic_w2x_sample(
    const unsigned char *rgb,
    int w,
    int h,
    int x,
    int y,
    int add_eta,
    double *r,
    double *g,
    double *b
) {
    if (x < 0) x = 0;
    if (y < 0) y = 0;
    if (x >= w) x = w - 1;
    if (y >= h) y = h - 1;
    const unsigned char *p = rgb + ((size_t)y * (size_t)w + (size_t)x) * 3;
    *r = (double)p[0] / 255.0;
    *g = (double)p[1] / 255.0;
    *b = (double)p[2] / 255.0;
    if (add_eta) {
        *r += kClipEta8;
        *g += kClipEta8;
        *b += kClipEta8;
    }
}

static int comic_w2x_expand(
    const unsigned char *rgb,
    int w,
    int h,
    double **out_chw,
    int *out_ew,
    int *out_eh
) {
    const int ew = w + 2 * kW2xShrink;
    const int eh = h + 2 * kW2xShrink;
    const size_t plane = (size_t)ew * (size_t)eh;
    double *arr = (double *)malloc(3 * plane * sizeof(double));
    if (!arr) {
        return -1;
    }
    memset(arr, 0, 3 * plane * sizeof(double));
    double r, g, b;
    for (int y = 0; y < h; y++) {
        for (int x = 0; x < w; x++) {
            comic_w2x_sample(rgb, w, h, x, y, 1, &r, &g, &b);
            const size_t i = (size_t)(y + kW2xShrink) * (size_t)ew + (size_t)(x + kW2xShrink);
            arr[i] = r;
            arr[i + plane] = g;
            arr[i + 2 * plane] = b;
        }
    }
    /* replicate edges without eta (same as waifu2x-ios) */
    for (int y = 0; y < eh; y++) {
        for (int x = 0; x < ew; x++) {
            if (x >= kW2xShrink && x < w + kW2xShrink && y >= kW2xShrink && y < h + kW2xShrink) {
                continue;
            }
            int sx = x - kW2xShrink;
            int sy = y - kW2xShrink;
            comic_w2x_sample(rgb, w, h, sx, sy, 0, &r, &g, &b);
            const size_t i = (size_t)y * (size_t)ew + (size_t)x;
            arr[i] = r;
            arr[i + plane] = g;
            arr[i + 2 * plane] = b;
        }
    }
    *out_chw = arr;
    *out_ew = ew;
    *out_eh = eh;
    return 0;
}

static int comic_w2x_origins(int w, int h, int **xs, int **ys, int *n_out) {
    const int bw = w < kW2xBlock ? kW2xBlock : w;
    const int bh = h < kW2xBlock ? kW2xBlock : h;
    const int num_w = bw / kW2xBlock;
    const int num_h = bh / kW2xBlock;
    const int ex_w = bw % kW2xBlock;
    const int ex_h = bh % kW2xBlock;
    int cap = num_w * num_h + num_h + num_w + 1;
    if (cap < 1) cap = 1;
    int *ox = (int *)malloc((size_t)cap * sizeof(int));
    int *oy = (int *)malloc((size_t)cap * sizeof(int));
    if (!ox || !oy) {
        free(ox);
        free(oy);
        return -1;
    }
    int n = 0;
    for (int i = 0; i < num_w; i++) {
        for (int j = 0; j < num_h; j++) {
            ox[n] = i * kW2xBlock;
            oy[n] = j * kW2xBlock;
            n++;
        }
    }
    if (ex_w > 0) {
        const int x = bw - kW2xBlock;
        for (int i = 0; i < num_h; i++) {
            ox[n] = x;
            oy[n] = i * kW2xBlock;
            n++;
        }
    }
    if (ex_h > 0) {
        const int y = bh - kW2xBlock;
        for (int i = 0; i < num_w; i++) {
            ox[n] = i * kW2xBlock;
            oy[n] = y;
            n++;
        }
    }
    if (ex_w > 0 && ex_h > 0) {
        ox[n] = bw - kW2xBlock;
        oy[n] = bh - kW2xBlock;
        n++;
    }
    *xs = ox;
    *ys = oy;
    *n_out = n;
    return 0;
}

static void comic_w2x_fill_tile(
    MLMultiArray *arr,
    const double *expanded,
    int ew,
    int eh,
    int ox,
    int oy
) {
    const size_t plane = (size_t)ew * (size_t)eh;
    const NSInteger sc = arr.strides[0].integerValue;
    const NSInteger sh = arr.strides[1].integerValue;
    const NSInteger sw = arr.strides[2].integerValue;
    double *din = (double *)arr.dataPointer;
    for (int ch = 0; ch < 3; ch++) {
        for (int y = 0; y < kW2xIn; y++) {
            const double *src = expanded + (size_t)ch * plane + (size_t)(oy + y) * (size_t)ew + (size_t)ox;
            if (sw == 1) {
                double *dst = din + ch * sc + y * sh;
                memcpy(dst, src, (size_t)kW2xIn * sizeof(double));
            } else {
                for (int x = 0; x < kW2xIn; x++) {
                    din[ch * sc + y * sh + x * sw] = src[x];
                }
            }
        }
    }
}

static int comic_w2x_copy_conv7(MLMultiArray *res, float *dst) {
    const int expect = 3 * kW2xOut * kW2xOut;
    if (!res || res.count < expect) {
        return -7;
    }
    if (res.dataType == MLMultiArrayDataTypeDouble) {
        const double *d = (const double *)res.dataPointer;
        for (int i = 0; i < expect; i++) {
            dst[i] = (float)d[i];
        }
        return 0;
    }
    if (res.dataType == MLMultiArrayDataTypeFloat32) {
        memcpy(dst, res.dataPointer, (size_t)expect * sizeof(float));
        return 0;
    }
    for (int i = 0; i < expect; i++) {
        dst[i] = res[i].floatValue;
    }
    return 0;
}

static void comic_w2x_blit(
    const float *tile,
    unsigned char *out_rgb,
    int out_w,
    int out_h,
    int dx0,
    int dy0
) {
    const int plane = kW2xOut * kW2xOut;
    for (int y = 0; y < kW2xOut; y++) {
        const int dy = dy0 + y;
        if (dy < 0 || dy >= out_h) {
            continue;
        }
        unsigned char *row = out_rgb + ((size_t)dy * (size_t)out_w) * 3;
        for (int x = 0; x < kW2xOut; x++) {
            const int dx = dx0 + x;
            if (dx < 0 || dx >= out_w) {
                continue;
            }
            const int si = y * kW2xOut + x;
            float r = tile[si] * 255.0f;
            float g = tile[si + plane] * 255.0f;
            float b = tile[si + 2 * plane] * 255.0f;
            if (r < 0) r = 0;
            if (r > 255) r = 255;
            if (g < 0) g = 0;
            if (g > 255) g = 255;
            if (b < 0) b = 0;
            if (b > 255) b = 255;
            unsigned char *p = row + (size_t)dx * 3;
            p[0] = (unsigned char)r;
            p[1] = (unsigned char)g;
            p[2] = (unsigned char)b;
        }
    }
}

int comic_w2x_coreml_enhance_rgb(
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
    const int ow = width * kW2xScale;
    const int oh = height * kW2xScale;
    if ((int64_t)ow * (int64_t)oh * 3 > out_cap) {
        return -8;
    }
    if (out_w) *out_w = ow;
    if (out_h) *out_h = oh;
    if (comic_w2x_cancelled(cancel_flag)) {
        return -9;
    }

    comic_w2x_ensure_lock();
    [g_lock lock];
    MLModel *model = g_model;
    if (!model) {
        [g_lock unlock];
        return -4;
    }
    if (comic_w2x_ensure_inputs() != 0) {
        [g_lock unlock];
        return -5;
    }

    int rc = 0;
    @autoreleasepool {
        /* pad tiny images to one block so crop origins stay valid */
        int pw = width;
        int ph = height;
        const unsigned char *src = rgb;
        unsigned char *padded = NULL;
        if (width < kW2xBlock || height < kW2xBlock) {
            pw = width < kW2xBlock ? kW2xBlock : width;
            ph = height < kW2xBlock ? kW2xBlock : height;
            padded = (unsigned char *)malloc((size_t)pw * (size_t)ph * 3);
            if (!padded) {
                [g_lock unlock];
                return -1;
            }
            for (int y = 0; y < ph; y++) {
                const int sy = y < height ? y : (height - 1);
                for (int x = 0; x < pw; x++) {
                    const int sx = x < width ? x : (width - 1);
                    memcpy(padded + ((size_t)y * (size_t)pw + (size_t)x) * 3,
                           rgb + ((size_t)sy * (size_t)width + (size_t)sx) * 3,
                           3);
                }
            }
            src = padded;
        }

        double *expanded = NULL;
        int ew = 0, eh = 0;
        if (comic_w2x_expand(src, pw, ph, &expanded, &ew, &eh) != 0) {
            free(padded);
            [g_lock unlock];
            return -1;
        }
        int *oxs = NULL;
        int *oys = NULL;
        int ntiles = 0;
        if (comic_w2x_origins(pw, ph, &oxs, &oys, &ntiles) != 0 || ntiles <= 0) {
            free(expanded);
            free(padded);
            [g_lock unlock];
            return -1;
        }

        float *tile_a = (float *)malloc((size_t)3 * kW2xOut * kW2xOut * sizeof(float));
        float *tile_b = (float *)malloc((size_t)3 * kW2xOut * kW2xOut * sizeof(float));
        if (!tile_a || !tile_b) {
            free(tile_a);
            free(tile_b);
            free(oxs);
            free(oys);
            free(expanded);
            free(padded);
            [g_lock unlock];
            return -1;
        }

        /* pipeline: fill i+1 while GPU predicts i */
        comic_w2x_fill_tile(g_in0, expanded, ew, eh, oxs[0], oys[0]);
        for (int i = 0; i < ntiles; i++) {
            if (comic_w2x_cancelled(cancel_flag)) {
                rc = -9;
                break;
            }
            MLMultiArray *cur_in = (i % 2) == 0 ? g_in0 : g_in1;
            ComicW2xInput *feat = (i % 2) == 0 ? g_feat0 : g_feat1;
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
            if (i + 1 < ntiles) {
                MLMultiArray *nxt = ((i + 1) % 2) == 0 ? g_in0 : g_in1;
                comic_w2x_fill_tile(nxt, expanded, ew, eh, oxs[i + 1], oys[i + 1]);
            }
            dispatch_semaphore_wait(sem, DISPATCH_TIME_FOREVER);
            if (!pred) {
                rc = -6;
                break;
            }
            MLFeatureValue *fv = [pred featureValueForName:@"conv7"];
            if (!fv) {
                fv = [pred featureValueForName:@"output"];
            }
            MLMultiArray *res = fv.multiArrayValue;
            float *tile = (i % 2) == 0 ? tile_a : tile_b;
            if (comic_w2x_copy_conv7(res, tile) != 0) {
                rc = -7;
                break;
            }
            comic_w2x_blit(tile, out_rgb, ow, oh, oxs[i] * kW2xScale, oys[i] * kW2xScale);
        }

        free(tile_a);
        free(tile_b);
        free(oxs);
        free(oys);
        free(expanded);
        free(padded);
    }
    [g_lock unlock];
    return rc;
}
