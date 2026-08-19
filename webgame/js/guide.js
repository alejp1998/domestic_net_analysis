/**
 * guide.js — theory/game tabs for the guide modal + MathJax typesetting.
 * Pure wiring: finds the guide modal (#guide or #guide-modal), wires the
 * .guide-tab buttons, and re-typesets MathJax whenever the modal becomes
 * visible or the tab switches (MutationObserver — works with any opener).
 */
(function () {
  "use strict";

  function typeset() {
    if (window.MathJax && MathJax.typesetPromise) {
      try {
        MathJax.typesetPromise().catch(function () {});
      } catch (e) {}
    }
  }

  function wire() {
    var modal = document.getElementById("guide-modal") || document.getElementById("guide");
    if (!modal) return;

    var tabs = Array.prototype.slice.call(modal.querySelectorAll(".guide-tab"));
    if (tabs.length) {
      tabs.forEach(function (tab) {
        tab.addEventListener("click", function () {
          tabs.forEach(function (t) {
            t.classList.toggle("active", t === tab);
          });
          var panels = modal.querySelectorAll(".guide-panel");
          panels.forEach(function (p) {
            p.classList.toggle("hidden", p.dataset.tab !== tab.dataset.tab);
          });
          typeset();
        });
      });
    }

    // typeset whenever the modal becomes visible (any opener, any close)
    if (typeof MutationObserver !== "undefined") {
      new MutationObserver(function () {
        if (!modal.classList.contains("hidden")) typeset();
      }).observe(modal, { attributes: true, attributeFilter: ["class"] });
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", wire);
  } else {
    wire();
  }
})();
