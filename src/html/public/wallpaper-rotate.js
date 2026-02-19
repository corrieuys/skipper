(function () {
  var gallery = window.__skipperGallery;
  if (!gallery || gallery.rotate_interval <= 0) return;

  function pick(arr) {
    if (!arr || arr.length === 0) return "";
    return arr[Math.floor(Math.random() * arr.length)];
  }

  function apply() {
    var root = document.documentElement;
    if (gallery.dark && gallery.dark.length >= 2) {
      root.style.setProperty("--app-bg-dark", 'url("' + pick(gallery.dark) + '")');
    }
    if (gallery.light && gallery.light.length >= 2) {
      root.style.setProperty("--app-bg-light", 'url("' + pick(gallery.light) + '")');
    }
  }

  setInterval(apply, gallery.rotate_interval * 1000);
})();
