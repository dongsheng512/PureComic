fn main() {
    let target_os = std::env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    if target_os != "macos" {
        return;
    }
    println!("cargo:rerun-if-changed=src/waifu2x_coreml.m");
    println!("cargo:rerun-if-changed=src/waifu2x_coreml.h");
    println!("cargo:rerun-if-changed=src/realesrgan_coreml.m");
    println!("cargo:rerun-if-changed=src/realesrgan_coreml.h");
    cc::Build::new()
        .file("src/waifu2x_coreml.m")
        .file("src/realesrgan_coreml.m")
        .flag("-fobjc-arc")
        .opt_level(3)
        .compile("comic_coreml");
    println!("cargo:rustc-link-lib=framework=Foundation");
    println!("cargo:rustc-link-lib=framework=CoreML");
    println!("cargo:rustc-link-lib=framework=CoreVideo");
    println!("cargo:rustc-link-lib=framework=Accelerate");
}
