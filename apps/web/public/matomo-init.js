// Matomo at stats.lastthaw.com: page views only, no cookies, honours Do Not Track. Nothing runs on localhost.
// A separate file, not an inline script: the site's Content Security Policy only runs scripts from its own files.
if (location.hostname.endsWith("lastthaw.com")) {
  var _paq = (window._paq = window._paq || []);
  _paq.push(["disableCookies"]);
  _paq.push(["setDoNotTrack", true]);
  _paq.push(["trackPageView"]);
  _paq.push(["enableLinkTracking"]);
  (function () {
    var u = "https://stats.lastthaw.com/";
    _paq.push(["setTrackerUrl", u + "matomo.php"]);
    _paq.push(["setSiteId", "1"]);
    var d = document, g = d.createElement("script"), s = d.getElementsByTagName("script")[0];
    g.async = true; g.src = u + "matomo.js"; s.parentNode.insertBefore(g, s);
  })();
}
