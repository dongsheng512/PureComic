#ifndef COMIC_REALESRGAN_COREML_H
#define COMIC_REALESRGAN_COREML_H

#ifdef __cplusplus
extern "C" {
#endif

/** Load or replace the cached Real-ESRGAN Core ML model. 0 = ok. */
int comic_esrgan_coreml_load(const char *model_path);

/**
 * 4× enhance one packed RGB8 image.
 * Writes packed RGB8 into out_rgb (capacity out_cap bytes).
 * Sets *out_w / *out_h to 4*width / 4*height.
 * cancel_flag: optional; non-zero aborts with -9.
 */
int comic_esrgan_coreml_enhance_rgb(
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
