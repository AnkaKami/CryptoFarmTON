'use strict';

(() => {
  const LOCALE = 'ru-RU';
  const TIME_PRESETS = ['09:00', '10:00', '11:00', '12:00', '13:00', '14:00', '15:00', '16:00', '17:00', '18:00', '19:00'];
  const DURATIONS = [60, 90, 120, 180, 240, 300, 360];
  const WEEKDAYS = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
  const STATUS = {
    new: { label: 'Новая', cls: 'pill-new' },
    confirmed: { label: 'Подтверждена', cls: 'pill-confirmed' },
    cancelled: { label: 'Отменена', cls: 'pill-cancelled' },
  };
  const FILTERS = [['new', 'Новые'], ['confirmed', 'Подтверждённые'], ['cancelled', 'Отменённые'], ['all', 'Все']];
  const MESSENGER = { zalo: 'Zalo', telegram: 'Telegram', whatsapp: 'WhatsApp', call: 'Звонок' };

  const $ = (id) => document.getElementById(id);

  const state = {
    config: null,
    today: null,
    now: null,
    month: null,
    slots: [],
    master: 'all',
    date: null,
    tab: 'slots',
    filter: 'new',
    bookings: [],
    counts: { new: 0, confirmed: 0, cancelled: 0 },
    times: new Set(['10:00', '15:00']),
    customTimes: new Set(),
    weekdays: new Set([1, 2, 3, 4, 5, 6, 7]),
    armed: null,
    flash: null,
  };

  // ---------- helpers ----------

  function h(tag, attrs, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs || {})) {
      if (value === false || value == null) continue;
      if (key === 'class') node.className = value;
      else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
      else if (key in node && typeof value !== 'string') node[key] = value;
      else node.setAttribute(key, value === true ? '' : value);
    }
    for (const child of children.flat()) {
      if (child == null || child === false) continue;
      node.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
    return node;
  }

  const masterName = (id) => state.config.masters.find((m) => m.id === id)?.name.ru || id;
  const serviceName = (id) => state.config.services.find((s) => s.id === id)?.name.ru || '—';
  const longDate = (date) => Cal.cap(Cal.format(date, LOCALE, { weekday: 'long', day: 'numeric', month: 'long' }));
  const shortDate = (date) => Cal.format(date, LOCALE, { weekday: 'short', day: 'numeric', month: 'long' });
  const isPast = (s) => s.date < state.today || (s.date === state.today && s.time <= state.now);
  const durLabel = (min) => (min < 60 ? `${min} мин` : `${String(min / 60).replace('.', ',')} ч`);

  function plural(n, one, few, many) {
    const form = new Intl.PluralRules(LOCALE).select(n);
    return `${n} ${form === 'one' ? one : form === 'few' ? few : many}`;
  }

  let toastTimer;
  function toast(text) {
    const el = $('toast');
    el.textContent = text;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, 3200);
  }

  class AuthError extends Error {}

  async function api(path, options = {}) {
    const res = await fetch(path, { credentials: 'same-origin', ...options });
    let data = null;
    try { data = await res.json(); } catch { /* empty body */ }
    if (res.status === 401 && path !== '/api/admin/login') {
      showLogin();
      throw new AuthError('unauthorized');
    }
    if (!res.ok) {
      const err = new Error(data?.error || `http_${res.status}`);
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  }

  const send = (path, method, body) => api(path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });

  function arm(key) {
    state.armed = key;
    setTimeout(() => {
      if (state.armed === key) {
        state.armed = null;
        renderDay();
        renderBookings();
      }
    }, 5000);
  }

  // ---------- auth ----------

  function showLogin() {
    $('app').hidden = true;
    $('login').hidden = false;
    $('password').focus();
  }

  async function showApp() {
    $('login').hidden = true;
    $('app').hidden = false;
    setupAddForm();
    await Promise.all([loadSlots(), loadBookings()]);
    state.date = state.date || state.today;
    setDefaultRange(state.date, Cal.addDays(state.date, 6));
    renderAll();
  }

  $('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = $('login-error');
    err.hidden = true;
    $('login-submit').disabled = true;
    try {
      await send('/api/admin/login', 'POST', { password: $('password').value });
      $('password').value = '';
      await showApp();
    } catch (ex) {
      err.textContent = ex.status === 429
        ? 'Слишком много попыток. Подождите 15 минут.'
        : ex.status === 401 ? 'Неверный пароль.' : 'Сервер не отвечает. Попробуйте ещё раз.';
      err.hidden = false;
    } finally {
      $('login-submit').disabled = false;
    }
  });

  $('logout').addEventListener('click', async () => {
    try { await send('/api/admin/logout', 'POST'); } catch { /* signed out anyway */ }
    showLogin();
  });

  // ---------- data ----------

  async function loadSlots() {
    const month = state.month || new Date().toISOString().slice(0, 7);
    const { from, to } = Cal.monthRange(month);
    const data = await api(`/api/admin/slots?from=${from}&to=${to}`);
    state.today = data.today;
    state.now = data.now;
    state.month = month;
    state.slots = data.slots;
  }

  async function loadBookings() {
    const data = await api('/api/admin/bookings?status=all');
    const before = state.counts.new;
    state.today = data.today;
    state.bookings = data.bookings;
    state.counts = { new: 0, confirmed: 0, cancelled: 0, ...data.counts };
    return state.counts.new - before;
  }

  // ---------- tabs ----------

  function setTab(tab) {
    state.tab = tab;
    $('tab-slots').setAttribute('aria-selected', String(tab === 'slots'));
    $('tab-bookings').setAttribute('aria-selected', String(tab === 'bookings'));
    $('panel-slots').hidden = tab !== 'slots';
    $('panel-bookings').hidden = tab !== 'bookings';
  }
  $('tab-slots').addEventListener('click', () => setTab('slots'));
  $('tab-bookings').addEventListener('click', () => { setTab('bookings'); renderBookings(); });

  function renderBadge() {
    const n = state.counts.new;
    $('new-badge').hidden = n === 0;
    $('new-badge').textContent = String(n);
    document.title = `${n ? `(${n}) ` : ''}Панель мастера — ${state.config.salon.name}`;
  }

  // ---------- calendar & day ----------

  const visible = (s) => state.master === 'all' || s.masterId === state.master;

  function renderCalendar() {
    Cal.render($('adm-calendar'), {
      month: state.month,
      locale: LOCALE,
      today: state.today,
      selected: state.date,
      labels: { prev: 'Предыдущий месяц', next: 'Следующий месяц' },
      info: (date) => {
        const day = state.slots.filter((s) => s.date === date && visible(s));
        const free = day.filter((s) => s.status === 'free' && !isPast(s)).length;
        const booked = day.filter((s) => s.status === 'booked').length;
        const marks = [];
        if (free) marks.push({ text: String(free), cls: 'm-free' });
        if (booked) marks.push({ text: String(booked), cls: 'm-booked' });
        const label = [free && `свободно ${free}`, booked && `занято ${booked}`].filter(Boolean).join(', ');
        return { cls: 'adm' + (date < state.today ? ' past' : ''), marks, label };
      },
      onSelect: (date) => {
        state.date = date;
        state.armed = null;
        if (date >= state.today) setDefaultRange(date, date);
        renderCalendar();
        renderDay();
      },
      onMonth: async (month) => {
        state.month = month;
        try { await loadSlots(); } catch (e) { if (!(e instanceof AuthError)) toast('Не удалось загрузить месяц'); }
        renderCalendar();
        renderDay();
      },
    });
  }

  function renderDay() {
    const card = $('day-card');
    card.textContent = '';
    if (!state.date) return;
    const day = state.slots.filter((s) => s.date === state.date && visible(s));
    card.append(h('div', { class: 'card-head' },
      h('h2', null, longDate(state.date)),
      h('span', { class: 'muted' }, day.length ? plural(day.length, 'окошко', 'окошка', 'окошек') : ''),
    ));
    if (!day.length) {
      card.append(h('p', { class: 'muted' }, state.date < state.today
        ? 'В этот день окошек не было.'
        : 'На этот день окошек нет. Добавьте их в форме ниже — даты уже подставлены.'));
      return;
    }
    card.append(h('ul', { class: 'slot-list' }, day.map(slotRow)));
  }

  function slotRow(s) {
    const past = isPast(s);
    const b = s.booking;
    let pill;
    let detail;
    let action = null;
    if (s.status === 'booked' && b) {
      pill = h('span', { class: `pill ${STATUS[b.status]?.cls || 'pill-new'}` }, STATUS[b.status]?.label || b.status);
      detail = `${b.name} · ${serviceName(b.serviceId)}`;
      action = h('button', {
        type: 'button', class: 'btn btn-quiet btn-sm',
        onclick: () => openBooking(b.id),
      }, 'Заявка');
    } else if (past) {
      pill = h('span', { class: 'pill pill-past' }, 'Прошло');
      detail = 'Никто не записался';
    } else {
      pill = h('span', { class: 'pill pill-free' }, 'Свободно');
      detail = 'Видно клиентам на сайте';
      const key = `del:${s.id}`;
      action = state.armed === key
        ? h('button', { type: 'button', class: 'btn btn-danger btn-sm', onclick: () => deleteSlot(s) }, 'Точно удалить?')
        : h('button', { type: 'button', class: 'btn btn-quiet btn-sm', onclick: () => { arm(key); renderDay(); } }, 'Удалить');
    }
    return h('li', { class: `slot-row${past ? ' is-past' : ''}` },
      h('span', { class: 'when' }, `${s.time}–${Cal.endTime(s.time, s.duration)}`),
      h('span', { class: 'who' }, h('strong', null, masterName(s.masterId)), h('span', null, detail)),
      h('span', { class: 'bk-actions' }, pill, action),
    );
  }

  async function deleteSlot(slot) {
    state.armed = null;
    try {
      await send(`/api/admin/slots/${slot.id}`, 'DELETE');
      toast(`Окошко ${slot.time} удалено`);
    } catch (e) {
      if (e instanceof AuthError) return;
      toast(e.status === 409 ? 'На это окошко уже записались — сначала отмените заявку' : 'Не удалось удалить окошко');
    }
    await refreshSlots();
  }

  async function refreshSlots() {
    try { await loadSlots(); } catch (e) { if (e instanceof AuthError) return; }
    renderCalendar();
    renderDay();
  }

  function openBooking(id) {
    state.filter = 'all';
    state.flash = id;
    setTab('bookings');
    renderBookings();
    document.querySelector(`[data-booking="${id}"]`)?.scrollIntoView({ block: 'center' });
    setTimeout(() => { state.flash = null; renderBookings(); }, 2500);
  }

  // ---------- add slots ----------

  function setDefaultRange(from, to) {
    $('add-from').value = from;
    $('add-to').value = to;
    renderAddSummary();
  }

  function setupAddForm() {
    const masterSel = $('adm-master');
    masterSel.replaceChildren(h('option', { value: 'all' }, 'Все мастера'),
      ...state.config.masters.map((m) => h('option', { value: m.id }, m.name.ru)));
    masterSel.value = state.master;
    masterSel.onchange = () => {
      state.master = masterSel.value;
      if (state.master !== 'all') $('add-master').value = state.master;
      renderCalendar();
      renderDay();
    };

    $('add-master').replaceChildren(...state.config.masters.map((m) => h('option', { value: m.id }, m.name.ru)));
    $('add-duration').replaceChildren(...DURATIONS.map((d) => h('option', { value: String(d) }, durLabel(d))));
    $('add-duration').value = '180';
    $('add-from').min = state.today || '';
    renderWeekdays();
    renderTimes();
  }

  function renderWeekdays() {
    $('add-weekdays').replaceChildren(...WEEKDAYS.map((label, i) => h('button', {
      type: 'button', class: 'chip', 'aria-pressed': String(state.weekdays.has(i + 1)),
      onclick: () => {
        if (state.weekdays.has(i + 1)) state.weekdays.delete(i + 1);
        else state.weekdays.add(i + 1);
        renderWeekdays();
        renderAddSummary();
      },
    }, label)));
  }

  function renderTimes() {
    const all = [...new Set([...TIME_PRESETS, ...state.customTimes])].sort();
    $('add-times').replaceChildren(...all.map((time) => h('button', {
      type: 'button', class: 'chip', 'aria-pressed': String(state.times.has(time)),
      onclick: () => {
        if (state.times.has(time)) state.times.delete(time);
        else state.times.add(time);
        renderTimes();
        renderAddSummary();
      },
    }, time)));
  }

  $('add-custom-btn').addEventListener('click', () => {
    const v = $('add-custom').value;
    if (!/^\d{2}:\d{2}$/.test(v)) { $('add-custom').focus(); return; }
    state.customTimes.add(v);
    state.times.add(v);
    $('add-custom').value = '';
    renderTimes();
    renderAddSummary();
  });

  function plannedDays() {
    const from = $('add-from').value;
    const to = $('add-to').value;
    if (!from || !to || to < from) return null;
    let n = 0;
    for (let d = from, i = 0; d <= to && i < 400; d = Cal.addDays(d, 1), i++) {
      const wd = new Date(d + 'T00:00:00Z').getUTCDay() || 7;
      if (state.weekdays.has(wd)) n++;
    }
    return n;
  }

  function renderAddSummary() {
    const days = plannedDays();
    const times = state.times.size;
    const out = $('add-summary');
    if (days === null) { out.textContent = 'Проверьте даты: «по» не может быть раньше «с».'; return; }
    if (!days || !times) { out.textContent = 'Выберите хотя бы один день недели и одно время.'; return; }
    out.textContent = `Будет создано до ${plural(days * times, 'окошка', 'окошек', 'окошек')}: ${plural(days, 'день', 'дня', 'дней')}, по ${times} в день. Окошки, которые пересекаются с уже существующими, пропустим.`;
  }
  $('add-from').addEventListener('change', () => {
    if ($('add-to').value < $('add-from').value) $('add-to').value = $('add-from').value;
    renderAddSummary();
  });
  $('add-to').addEventListener('change', renderAddSummary);

  $('add-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const result = $('add-result');
    const days = plannedDays();
    if (!days || !state.times.size) {
      renderAddSummary();
      $('add-summary').focus?.();
      return;
    }
    $('add-submit').disabled = true;
    result.hidden = true;
    try {
      const r = await send('/api/admin/slots', 'POST', {
        masterId: $('add-master').value,
        from: $('add-from').value,
        to: $('add-to').value,
        weekdays: [...state.weekdays],
        times: [...state.times],
        duration: Number($('add-duration').value),
      });
      const parts = [r.added ? `Добавлено ${plural(r.added, 'окошко', 'окошка', 'окошек')}.` : 'Новых окошек не добавлено.'];
      if (r.skippedOverlap) parts.push(`Пропущено ${r.skippedOverlap}: пересекаются с уже существующими.`);
      if (r.skippedPast) parts.push(`Пропущено ${r.skippedPast}: время уже прошло.`);
      result.className = `alert ${r.added ? 'alert-ok' : 'alert-info'}`;
      result.textContent = parts.join(' ');
      result.hidden = false;
      await refreshSlots();
    } catch (ex) {
      if (ex instanceof AuthError) return;
      result.className = 'alert alert-error';
      result.textContent = ex.data?.detail === 'dates'
        ? 'Проверьте даты: период не длиннее 120 дней, «по» не раньше «с».'
        : ex.data?.detail === 'too_many' ? 'За один раз можно добавить до 500 окошек. Сократите период.' : 'Не удалось добавить окошки. Проверьте поля и попробуйте ещё раз.';
      result.hidden = false;
    } finally {
      $('add-submit').disabled = false;
    }
  });

  // ---------- bookings ----------

  function renderFilter() {
    const total = state.counts.new + state.counts.confirmed + state.counts.cancelled;
    $('bk-filter').replaceChildren(...FILTERS.map(([key, label]) => h('button', {
      type: 'button', class: 'chip', 'aria-pressed': String(state.filter === key),
      onclick: () => { state.filter = key; renderBookings(); },
    }, label, h('span', { class: 'count' }, String(key === 'all' ? total : state.counts[key] || 0)))));
  }

  function contactLinks(b) {
    const phoneDigits = b.phone.replace(/\D/g, '');
    const handle = b.handle.trim();
    const handleDigits = handle.replace(/\D/g, '');
    const useDigits = handleDigits.length >= 7 ? handleDigits : phoneDigits;
    const links = [];
    if (b.messenger === 'whatsapp') links.push(['WhatsApp', `https://wa.me/${useDigits}`]);
    if (b.messenger === 'zalo') links.push(['Zalo', `https://zalo.me/${useDigits}`]);
    if (b.messenger === 'telegram') {
      if (handle && /^@?[A-Za-z][\w]{3,}$/.test(handle)) links.push(['Telegram', `https://t.me/${handle.replace(/^@/, '')}`]);
      else links.push(['Telegram', `https://t.me/+${useDigits}`]);
    }
    links.push(['Позвонить', `tel:+${phoneDigits}`]);
    return links;
  }

  function sortBookings(list) {
    const key = (b) => b.date + b.time;
    const upcoming = list.filter((b) => b.date >= state.today).sort((a, b) => key(a).localeCompare(key(b)));
    const past = list.filter((b) => b.date < state.today).sort((a, b) => key(b).localeCompare(key(a)));
    return upcoming.concat(past);
  }

  function renderBookings() {
    renderFilter();
    renderBadge();
    const root = $('bk-list');
    const list = sortBookings(state.bookings.filter((b) => state.filter === 'all' || b.status === state.filter));
    if (!list.length) {
      root.replaceChildren(h('p', { class: 'muted' }, state.filter === 'new'
        ? 'Новых заявок нет. Когда клиент запишется, заявка появится здесь.'
        : 'Здесь пока пусто.'));
      return;
    }
    root.replaceChildren(...list.map(bookingCard));
  }

  function bookingCard(b) {
    const status = STATUS[b.status] || STATUS.new;
    const created = new Date(b.createdAt).toLocaleString(LOCALE, {
      timeZone: state.config.timezone || 'Asia/Ho_Chi_Minh', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
    });
    const cancelKey = `cancel:${b.id}`;
    const actions = [];
    if (b.status === 'new') {
      actions.push(h('button', { type: 'button', class: 'btn btn-primary btn-sm', onclick: () => setStatus(b, 'confirmed') }, 'Подтвердить'));
    }
    if (b.status !== 'cancelled') {
      actions.push(state.armed === cancelKey
        ? h('button', { type: 'button', class: 'btn btn-danger btn-sm', onclick: () => setStatus(b, 'cancelled') }, 'Точно отменить? Окошко освободится')
        : h('button', { type: 'button', class: 'btn btn-ghost btn-sm', onclick: () => { arm(cancelKey); renderBookings(); } }, 'Отменить'));
    } else {
      actions.push(h('button', { type: 'button', class: 'btn btn-ghost btn-sm', onclick: () => setStatus(b, 'new') }, 'Вернуть заявку'));
    }

    const phoneBtn = h('button', { type: 'button', class: 'btn btn-quiet btn-sm' }, 'Скопировать');
    phoneBtn.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(b.phone); toast('Номер скопирован'); } catch { /* number stays selectable */ }
    });

    return h('article', {
      class: `bk${b.status === 'new' ? ' is-new' : ''}${state.flash === b.id ? ' is-flash' : ''}`,
      'data-booking': b.id,
    },
    h('div', { class: 'bk-top' },
      h('span', { class: 'bk-when' }, `${shortDate(b.date)} · ${b.time}–${Cal.endTime(b.time, b.duration)}`),
      h('span', { class: 'muted' }, masterName(b.masterId)),
      h('span', { class: `pill ${status.cls}` }, status.label),
    ),
    h('div', { class: 'bk-body' },
      h('dl', null,
        h('dt', null, 'Клиент'), h('dd', null, h('strong', null, b.name)),
        h('dt', null, 'Телефон'), h('dd', null, h('span', { class: 'mono' }, b.phone), ' ', phoneBtn),
        h('dt', null, 'Связь'), h('dd', null, `${MESSENGER[b.messenger] || b.messenger}${b.handle ? `: ${b.handle}` : ''}`),
      ),
      h('dl', null,
        h('dt', null, 'Услуга'), h('dd', null, serviceName(b.serviceId)),
        h('dt', null, 'Длина'), h('dd', null, b.length ? `${b.length} см` : 'на выбор мастера'),
        h('dt', null, 'Написать'), h('dd', null, h('span', { class: 'links' },
          contactLinks(b).map(([label, href]) => h('a', { href, target: href.startsWith('http') ? '_blank' : null, rel: 'noopener' }, label)))),
      ),
    ),
    b.comment ? h('p', { class: 'bk-comment' }, b.comment) : null,
    h('div', { class: 'bk-actions' }, actions, h('span', { class: 'meta' }, `Заявка от ${created}`)),
    );
  }

  async function setStatus(b, status) {
    state.armed = null;
    try {
      await send(`/api/admin/bookings/${b.id}`, 'PATCH', { status });
      toast(status === 'confirmed' ? `${b.name}: запись подтверждена` : status === 'cancelled' ? 'Заявка отменена, окошко снова свободно' : 'Заявка возвращена');
    } catch (e) {
      if (e instanceof AuthError) return;
      toast(e.status === 409 ? 'Окошко уже занято или удалено — вернуть заявку нельзя' : 'Не удалось изменить заявку');
    }
    await Promise.allSettled([loadBookings(), loadSlots()]);
    renderAll();
  }

  // ---------- refresh ----------

  function renderAll() {
    renderBadge();
    renderCalendar();
    renderDay();
    renderBookings();
    renderAddSummary();
  }

  async function poll() {
    if ($('app').hidden || document.hidden || state.armed) return;
    try {
      const fresh = await loadBookings();
      await loadSlots();
      if (fresh > 0) toast(fresh === 1 ? 'Новая заявка' : `Новых заявок: ${fresh}`);
      renderAll();
    } catch { /* next poll will retry */ }
  }
  setInterval(poll, 60000);
  document.addEventListener('visibilitychange', poll);

  // ---------- start ----------

  async function init() {
    try {
      state.config = await api('/api/config');
      for (const el of document.querySelectorAll('.salon-name')) el.textContent = state.config.salon.name;
    } catch {
      $('login').hidden = false;
      $('login-error').textContent = 'Сервер не отвечает. Обновите страницу.';
      $('login-error').hidden = false;
      return;
    }
    try {
      const session = await api('/api/admin/session');
      if (session.ok) await showApp();
      else showLogin();
    } catch (e) {
      if (!(e instanceof AuthError)) showLogin();
    }
  }

  init();
})();
