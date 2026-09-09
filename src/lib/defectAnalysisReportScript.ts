/** 缺陷分析 HTML 报告内嵌脚本（扇形图悬停 + 类型展开收起） */
export const DEFECT_ANALYSIS_REPORT_SCRIPT = `
(function () {
  var CX = 160, CY = 160, R = 152, EXPLODE = 10;
  var dataEl = document.getElementById("pie-data");
  if (!dataEl) return;
  var slices = JSON.parse(dataEl.textContent);
  var paths = document.querySelectorAll(".pie-slice");
  var legendItems = document.querySelectorAll(".legend-item");
  var tooltip = document.getElementById("pie-tooltip");
  var chartWrap = document.getElementById("chart-wrap");
  var activeIdx = null;

  function slicePath(start, end, explode) {
    var mid = (start + end) / 2;
    var ox = explode * Math.cos(mid);
    var oy = explode * Math.sin(mid);
    var x = CX + ox, y = CY + oy;
    var sweep = end - start;
    if (sweep / (2 * Math.PI) >= 0.9999) {
      return "M " + x + " " + (y - R) + " A " + R + " " + R + " 0 1 1 " + (x - 0.01) + " " + (y - R) + " Z";
    }
    var x1 = x + R * Math.cos(start), y1 = y + R * Math.sin(start);
    var x2 = x + R * Math.cos(end), y2 = y + R * Math.sin(end);
    var large = sweep > Math.PI ? 1 : 0;
    return "M " + x + " " + y + " L " + x1 + " " + y1 + " A " + R + " " + R + " 0 " + large + " 1 " + x2 + " " + y2 + " Z";
  }

  function esc(t) {
    return String(t)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function redrawPie(hoverIdx) {
    for (var i = 0; i < slices.length; i++) {
      var s = slices[i], el = paths[i];
      if (!el) continue;
      el.setAttribute(
        "d",
        slicePath(s.startAngle, s.endAngle, hoverIdx === i ? EXPLODE : 0),
      );
      el.classList.toggle("active", hoverIdx === i);
      el.classList.toggle("dim", hoverIdx !== null && hoverIdx !== i);
    }
    legendItems.forEach(function (li, i) {
      li.classList.toggle("active", hoverIdx === i);
    });
  }

  function showTooltip(idx, x, y) {
    var s = slices[idx];
    if (!s || !tooltip) return;
    var sum = s.summary
      ? '<div class="tip-summary">' + esc(s.summary) + "</div>"
      : "";
    tooltip.innerHTML =
      "<strong>" +
      esc(s.type) +
      '</strong><div class="tip-meta">同类缺陷 ' +
      s.value +
      " 个 · " +
      s.percent.toFixed(1) +
      "%</div>" +
      sum;
    tooltip.classList.add("show");
    tooltip.style.left = x + "px";
    tooltip.style.top = y + "px";
  }

  function hideTooltip() {
    if (tooltip) tooltip.classList.remove("show");
  }

  function activateSlice(idx, x, y) {
    activeIdx = idx;
    redrawPie(idx);
    showTooltip(idx, x, y);
  }

  function deactivatePie() {
    activeIdx = null;
    redrawPie(null);
    hideTooltip();
  }

  paths.forEach(function (el, i) {
    el.addEventListener("mouseenter", function (e) {
      activateSlice(i, e.clientX, e.clientY);
    });
    el.addEventListener("mousemove", function (e) {
      if (activeIdx === i) showTooltip(i, e.clientX, e.clientY);
    });
    el.addEventListener("mouseleave", deactivatePie);
  });

  legendItems.forEach(function (li, i) {
    li.addEventListener("mouseenter", function (e) {
      var rect = paths[i] && paths[i].getBoundingClientRect();
      activateSlice(
        i,
        rect ? rect.left + rect.width / 2 : e.clientX,
        rect ? rect.top + rect.height / 2 : e.clientY,
      );
    });
    li.addEventListener("mouseleave", deactivatePie);
  });

  if (chartWrap) chartWrap.addEventListener("mouseleave", deactivatePie);

  document.querySelectorAll(".type-toggle").forEach(function (btn) {
    btn.addEventListener("click", function () {
      var expanded = btn.getAttribute("aria-expanded") === "true";
      var panelId = btn.getAttribute("aria-controls");
      var panel = panelId ? document.getElementById(panelId) : null;
      var chevron = btn.querySelector(".chevron");
      btn.setAttribute("aria-expanded", expanded ? "false" : "true");
      if (chevron) chevron.textContent = expanded ? "▶" : "▼";
      if (panel) panel.hidden = expanded;
    });
  });
})();
`;
