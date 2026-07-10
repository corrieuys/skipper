/**
 * Weekly schedule matrix editor (7 days x 24 hours).
 * Document-level event delegation only, so editors that arrive via HTMX
 * fragment swaps work without any init hook. Markup comes from
 * src/html/atoms/schedule-matrix.ts; readonly grids lack [data-schedmatrix]
 * and are ignored here.
 */
(function () {
  var painting = false;
  var paintValue = false;

  function editorFor(el) {
    return el.closest ? el.closest("[data-schedmatrix]") : null;
  }

  function setCell(cell, on) {
    cell.classList.toggle("is-on", on);
  }

  function serialize(editor) {
    var matrix = [];
    for (var d = 0; d < 7; d++) {
      var row = [];
      for (var h = 0; h < 24; h++) row.push(0);
      matrix.push(row);
    }
    var count = 0;
    editor.querySelectorAll(".sk-schedmatrix__cell.is-on").forEach(function (cell) {
      var day = parseInt(cell.getAttribute("data-day"), 10);
      var hour = parseInt(cell.getAttribute("data-hour"), 10);
      if (day >= 0 && day < 7 && hour >= 0 && hour < 24) {
        matrix[day][hour] = 1;
        count++;
      }
    });
    var input = editor.querySelector("input[name=scheduleMatrix]");
    if (input) input.value = count > 0 ? JSON.stringify(matrix) : "";
    var summary = editor.querySelector("[data-schedmatrix-summary]");
    if (summary) {
      summary.textContent = count + " hours/week. Click or drag to paint; headers toggle a whole day or hour. Times are server-local.";
    }
  }

  document.addEventListener("mousedown", function (e) {
    var cell = e.target.closest ? e.target.closest(".sk-schedmatrix__cell") : null;
    if (!cell) return;
    var editor = editorFor(cell);
    if (!editor) return;
    e.preventDefault();
    paintValue = !cell.classList.contains("is-on");
    painting = true;
    setCell(cell, paintValue);
    serialize(editor);
  });

  document.addEventListener("mouseover", function (e) {
    if (!painting) return;
    var cell = e.target.closest ? e.target.closest(".sk-schedmatrix__cell") : null;
    if (!cell) return;
    var editor = editorFor(cell);
    if (!editor) return;
    setCell(cell, paintValue);
    serialize(editor);
  });

  document.addEventListener("mouseup", function () {
    painting = false;
  });

  document.addEventListener("click", function (e) {
    var target = e.target;
    if (!target.closest) return;

    // Row/column header: if any cell in the group is off, turn all on; else all off.
    var header = target.closest(".sk-schedmatrix__hrow[data-row], .sk-schedmatrix__hcol[data-col]");
    if (header) {
      var editor = editorFor(header);
      if (!editor) return;
      var row = header.getAttribute("data-row");
      var col = header.getAttribute("data-col");
      var selector = row !== null
        ? '.sk-schedmatrix__cell[data-day="' + row + '"]'
        : '.sk-schedmatrix__cell[data-hour="' + col + '"]';
      var cells = editor.querySelectorAll(selector);
      var anyOff = false;
      cells.forEach(function (cell) {
        if (!cell.classList.contains("is-on")) anyOff = true;
      });
      cells.forEach(function (cell) {
        setCell(cell, anyOff);
      });
      serialize(editor);
      return;
    }
  });

  // Schedule mode select: swap between interval and weekly fields. The
  // inactive mode's inputs are disabled (disabled fields do not submit), so
  // the server-side interval/matrix exclusivity always holds while painted
  // or typed values survive toggling back and forth.
  document.addEventListener("change", function (e) {
    var select = e.target;
    if (!select.matches || !select.matches("select[name=scheduleMode]")) return;
    var form = select.form;
    if (!form) return;
    var intervalFields = form.querySelector("#schedule-interval-fields");
    var matrixFields = form.querySelector("#schedule-matrix-fields");
    var mode = select.value;

    if (intervalFields) {
      intervalFields.style.display = mode === "interval" ? "" : "none";
      var unit = form.querySelector("[name=scheduleUnit]");
      var amount = form.querySelector("[name=scheduleAmount]");
      if (unit) unit.disabled = mode !== "interval";
      if (amount) amount.disabled = mode !== "interval";
    }
    if (matrixFields) {
      matrixFields.style.display = mode === "weekly" ? "" : "none";
      var input = matrixFields.querySelector("input[name=scheduleMatrix]");
      if (input) input.disabled = mode !== "weekly";
    }
  });
})();
