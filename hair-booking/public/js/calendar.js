'use strict';

// Month calendar shared by the public site and the admin panel.
// Dates are salon-local "YYYY-MM-DD" strings; formatting runs in UTC so the viewer's own timezone never shifts a day.
window.Cal = (() => {
  const pad = (n) => String(n).padStart(2, '0');

  function addMonths(month, n) {
    const [y, m] = month.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1 + n, 1)).toISOString().slice(0, 7);
  }

  function addDays(date, n) {
    const [y, m, d] = date.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
  }

  function monthRange(month) {
    const [y, m] = month.split('-').map(Number);
    const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
    return { from: `${month}-01`, to: `${month}-${pad(last)}` };
  }

  function format(date, locale, opts) {
    return new Intl.DateTimeFormat(locale, { timeZone: 'UTC', ...opts }).format(new Date(date + 'T00:00:00Z'));
  }

  const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

  function monthTitle(month, locale) {
    const date = month + '-01';
    return `${cap(format(date, locale, { month: 'long' }))} ${month.slice(0, 4)}`;
  }

  function weekdayNames(locale) {
    // 2024-01-01 was a Monday.
    return Array.from({ length: 7 }, (_, i) => format(`2024-01-0${i + 1}`, locale, { weekday: 'short' }).replace('.', ''));
  }

  function endTime(time, minutes) {
    const total = Number(time.slice(0, 2)) * 60 + Number(time.slice(3)) + minutes;
    return `${pad(Math.floor(total / 60) % 24)}:${pad(total % 60)}`;
  }

  /**
   * opts: { month, locale, today, selected, minMonth, maxMonth, labels: {prev, next},
   *         info(date) -> { disabled, cls, marks: [{text, cls}], label }, onSelect(date), onMonth(month) }
   */
  function render(root, opts) {
    const { month, locale, today, selected, minMonth, maxMonth, labels, info } = opts;
    root.textContent = '';

    const head = document.createElement('div');
    head.className = 'cal-head';
    const prev = navButton('‹', labels.prev, minMonth && month <= minMonth, () => opts.onMonth(addMonths(month, -1)));
    const next = navButton('›', labels.next, maxMonth && month >= maxMonth, () => opts.onMonth(addMonths(month, 1)));
    const title = document.createElement('h3');
    title.className = 'cal-title';
    title.textContent = monthTitle(month, locale);
    title.setAttribute('aria-live', 'polite');
    head.append(prev, title, next);

    const grid = document.createElement('div');
    grid.className = 'cal-grid';
    for (const wd of weekdayNames(locale)) {
      const cell = document.createElement('div');
      cell.className = 'cal-wd';
      cell.textContent = wd;
      cell.setAttribute('aria-hidden', 'true');
      grid.append(cell);
    }

    const { to } = monthRange(month);
    const first = month + '-01';
    const firstWd = new Date(first + 'T00:00:00Z').getUTCDay() || 7;
    for (let i = 1; i < firstWd; i++) grid.append(document.createElement('div'));

    const days = Number(to.slice(8));
    for (let d = 1; d <= days; d++) {
      const date = `${month}-${pad(d)}`;
      const meta = info(date) || {};
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'cal-day' + (meta.cls ? ' ' + meta.cls : '');
      if (date === today) btn.classList.add('is-today');
      if (date === selected) {
        btn.classList.add('is-selected');
        btn.setAttribute('aria-pressed', 'true');
      } else {
        btn.setAttribute('aria-pressed', 'false');
      }
      btn.disabled = Boolean(meta.disabled);
      btn.dataset.date = date;
      const label = format(date, locale, { weekday: 'long', day: 'numeric', month: 'long' });
      btn.setAttribute('aria-label', meta.label ? `${label}, ${meta.label}` : label);

      const num = document.createElement('span');
      num.textContent = String(d);
      const marks = document.createElement('span');
      marks.className = 'cal-marks';
      for (const mark of meta.marks || []) {
        const m = document.createElement('span');
        m.className = 'cal-mark' + (mark.cls ? ' ' + mark.cls : '');
        m.textContent = mark.text;
        marks.append(m);
      }
      btn.append(num, marks);
      btn.addEventListener('click', () => opts.onSelect(date));
      grid.append(btn);
    }

    root.append(head, grid);
  }

  function navButton(text, label, disabled, onClick) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'cal-nav';
    b.textContent = text;
    b.setAttribute('aria-label', label);
    b.disabled = Boolean(disabled);
    b.addEventListener('click', onClick);
    return b;
  }

  return { addMonths, addDays, monthRange, format, monthTitle, endTime, render, pad, cap };
})();
