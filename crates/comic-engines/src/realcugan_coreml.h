#ifndef COMIC_REALCUGAN_COREML_H
#define COMIC_REALCUGAN_COREML_H

#ifdef __cplusplus
extern "C" {
#endif

/** Load or replace the cached Real-CUGAN Core ML model. 0 = ok. */
int comic_cugan_coreml_load(const char *model_path);

/**
 * Enhance one RGB8 image (packed, no padding) 2× (SE conservative / denoise).
 * Writes packed RGB8 into out_rgb (capacity out_cap bytes).
 * Sets *out_w / *out_h to 2*width / 2*height.
 * cancel_flag: optional; if non-NULL and *cancel_flag != 0, abort with -9.
 */
int comic_cugan_coreml_enhance_rgb(
    const unsigned char *rgb,
    int width,
    int height,
    unsigned char *out_rgb,
    int out_cap,
    int *out_w,
    int *out_h,
    const int *cancel_flag
);

#ifdef __cplusplus
}
#endif

#endif
