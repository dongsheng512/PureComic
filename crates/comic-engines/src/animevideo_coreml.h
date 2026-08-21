#ifndef COMIC_ANIMEVIDEO_COREML_H
#define COMIC_ANIMEVIDEO_COREML_H

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/* Load realesr-animevideov3 mlpackage/mlmodelc. Returns 0 on success. */
int comic_animevideo_coreml_load(const char *model_path);

/* RGB888 in, 4× RGB888 out. Tile-fixed 512² inference with reflect pad 10.
   Returns 0 ok, -9 cancelled, negative otherwise. */
int comic_animevideo_coreml_enhance_rgb(
    const unsigned char *rgb,
    int width,
    int height,
    unsigned char *out_rgb,
    int out_cap,
    int *out_w,
    int *out_h,
    const int *cancel_flag);

#ifdef __cplusplus
}
#endif

#endif /* COMIC_ANIMEVIDEO_COREML_H */
