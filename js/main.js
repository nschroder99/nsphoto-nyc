(function () {
  var header = document.getElementById("site-header");
  var toggle = document.getElementById("nav-toggle");

  if (!header || !toggle) return;

  toggle.addEventListener("click", function () {
    var isOpen = header.classList.toggle("is-open");
    toggle.setAttribute("aria-expanded", isOpen ? "true" : "false");
  });

  header.querySelectorAll(".nav-links a").forEach(function (link) {
    link.addEventListener("click", function () {
      header.classList.remove("is-open");
      toggle.setAttribute("aria-expanded", "false");
    });
  });
})();
