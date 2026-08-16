// 主题预置：同步经典脚本，在首帧前设置背景色，避免冷启动白闪。
// 生产 CSP 为 default-src 'self'，内联脚本会被拦截，故放 public/ 由 <script src> 加载。
(function () {
  try {
    var light = localStorage.getItem("comic.theme") === "light";
    if (light) {
      document.documentElement.classList.remove("dark");
      document.documentElement.style.backgroundColor = "#F5F5F7";
    } else {
      document.documentElement.style.backgroundColor = "#16171C";
    }
  } catch (_) {}
})();
