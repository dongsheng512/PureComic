/** 漫画/电子书格式集中定义：对话框 filter、拖拽识别、外部打开校验共用 */

export const COMIC_EXTENSIONS = [
  "cbz",
  "cbr",
  "zip",
  "rar",
  "epub",
  "mobi",
  "azw",
  "azw3",
] as const;

export const COMIC_EXT_RE = /\.(cbz|zip|cbr|rar|epub|mobi|azw|azw3)$/i;

export function isComicPath(path: string): boolean {
  return COMIC_EXT_RE.test(path);
}

/** 文件选择对话框的 comic 过滤器（name 由 i18n 提供时传 label） */
export function comicFileFilter(label = "Comic / Ebook") {
  return {
    name: label,
    extensions: [...COMIC_EXTENSIONS],
  };
}
