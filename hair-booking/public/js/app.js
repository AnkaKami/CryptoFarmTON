'use strict';

(() => {
  const LANGS = ['ru', 'en', 'vi'];
  const MESSENGERS = ['zalo', 'telegram', 'whatsapp', 'call'];
  const MONTHS_AHEAD = 5;

  const store = {
    get(key) { try { return localStorage.getItem(key); } catch { return null; } },
    set(key, value) { try { localStorage.setItem(key, value); } catch { /* storage blocked */ } },
  };

  const state = {
    lang: pickLang(),
    config: null,
    today: null,
    month: null,
    months: new Map(),
    master: 'all',
    date: null,
    slotId: null,
    done: null,
    sending: false,
    formError: '',
    fieldErrors: [],
    loadError: false,
  };

  const draft = Object.assign(
    { name: '', phone: '', messenger: 'zalo', handle: '', serviceId: '', length: '', comment: '' },
    readContact(),
  );

  // ---------- i18n ----------

  function pickLang() {
    const saved = store.get('lang');
    if (LANGS.includes(saved)) return saved;
    const nav = (navigator.language || '').slice(0, 2).toLowerCase();
    if (['ru', 'uk', 'be', 'kk'].includes(nav)) return 'ru';
    if (nav === 'vi') return 'vi';
    return 'en';
  }

  const dict = () => window.I18N[state.lang];
  const locale = () => dict().locale;

  function t(key, vars) {
    let s = dict()[key] ?? window.I18N.ru[key] ?? key;
    if (s && typeof s === 'object') {
      const form = new Intl.PluralRules(locale()).select(vars?.n ?? 0);
      s = s[form] ?? s.other;
    }
    return vars ? s.replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? '')) : s;
  }

  const local = (obj) => (obj ? obj[state.lang] || obj.ru || obj.en || '' : '');

  function applyStatic() {
    document.documentElement.lang = state.lang;
    for (const node of document.querySelectorAll('[data-i18n]')) node.textContent = t(node.dataset.i18n);
    for (const btn of document.querySelectorAll('[data-lang]')) {
      btn.setAttribute('aria-pressed', String(btn.dataset.lang === state.lang));
    }
    const name = state.config?.salon?.name || document.getElementById('brand-name').textContent;
    document.title = `${name} — ${t('meta.tagline')}`;
  }

  // ---------- formatting ----------

  function money(value) {
    return new Intl.NumberFormat(locale(), { style: 'currency', currency: 'VND', maximumFractionDigits: 0 }).format(value);
  }

  function duration(min) {
    if (min < 60) return `≈ ${min} ${t('dur.min')}`;
    const hours = new Intl.NumberFormat(locale(), { maximumFractionDigits: 1 }).format(min / 60);
    return `≈ ${hours} ${t('dur.h')}`;
  }

  const longDate = (date) => Cal.cap(Cal.format(date, locale(), { weekday: 'long', day: 'numeric', month: 'long' }));
  const shortDate = (date) => Cal.format(date, locale(), { weekday: 'short', day: 'numeric', month: 'long' });
  const masterName = (id) => local(state.config.masters.find((m) => m.id === id)?.name) || id;
  const serviceName = (id) => local(state.config.services.find((s) => s.id === id)?.name) || '';

  // ---------- dom helper ----------

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

  // ---------- api ----------

  async function api(path, options) {
    const res = await fetch(path, options);
    let data = null;
    try { data = await res.json(); } catch { /* empty body */ }
    if (!res.ok) {
      const err = new Error(data?.error || `http_${res.status}`);
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  }

  async function loadMonth(month, force) {
    if (!force && state.months.has(month)) return;
    const { from, to } = Cal.monthRange(month);
    const data = await api(`/api/slots?from=${from}&to=${to}`);
    state.today = data.today;
    state.months.set(month, data.slots);
  }

  const visible = (slot) => state.master === 'all' || slot.masterId === state.master;
  const slotsOn = (date) => (state.months.get(date.slice(0, 7)) || []).filter((s) => s.date === date && visible(s));

  function nearestSlot() {
    const months = [...state.months.keys()].sort();
    for (const m of months) {
      const hit = state.months.get(m).find(visible);
      if (hit) return hit;
    }
    return null;
  }

  function findSlot(id) {
    for (const list of state.months.values()) {
      const hit = list.find((s) => s.id === id);
      if (hit) return hit;
    }
    return null;
  }

  // ---------- static content ----------

  function renderServices() {
    const list = document.getElementById('prices');
    list.textContent = '';
    for (const s of state.config.services) {
      list.append(h('li', { class: 'price-row' },
        h('div', null, h('h3', null, local(s.name)), h('p', null, local(s.details))),
        h('span', { class: 'price-dur' }, duration(s.duration)),
        h('span', { class: 'price-val' }, s.priceFrom ? `${t('price.from')} ${money(s.priceFrom)}` : t('price.free')),
      ));
    }
  }

  function renderMasters() {
    const list = document.getElementById('masters-list');
    list.textContent = '';
    for (const m of state.config.masters) {
      const name = local(m.name);
      list.append(h('article', { class: 'master' },
        h('div', { class: 'monogram', 'aria-hidden': 'true' }, name.charAt(0)),
        h('h3', null, name),
        h('div', null,
          h('p', null, local(m.role)),
          m.years ? h('p', { class: 'years' }, t('masters.years', { n: m.years })) : null,
        ),
        h('button', {
          type: 'button', class: 'btn btn-ghost btn-sm',
          onclick: () => { setMaster(m.id); document.getElementById('booking').scrollIntoView(); },
        }, t('masters.cta')),
      ));
    }
  }

  function renderInfo() {
    const { salon } = state.config;
    document.getElementById('brand-name').textContent = salon.name;
    document.getElementById('footer-name').textContent = salon.name;
    document.getElementById('year').textContent = String(new Date().getFullYear());
    document.getElementById('info-area').textContent = local(salon.area);
    document.getElementById('info-note').textContent = local(salon.addressNote);
    document.getElementById('info-hours').textContent = local(salon.hours);

    const box = document.getElementById('info-contacts');
    box.querySelectorAll('.contact-row').forEach((n) => n.remove());
    const c = salon.contacts || {};
    const digits = (v) => v.replace(/\D/g, '');
    const handle = (v) => v.replace(/^@/, '');
    const rows = [
      ['tel', c.phone, c.phone && `tel:${c.phone.replace(/[^\d+]/g, '')}`],
      ['Zalo', c.zalo, c.zalo && `https://zalo.me/${digits(c.zalo)}`],
      ['Telegram', c.telegram, c.telegram && `https://t.me/${handle(c.telegram)}`],
      ['WhatsApp', c.whatsapp, c.whatsapp && `https://wa.me/${digits(c.whatsapp)}`],
      ['Instagram', c.instagram, c.instagram && `https://instagram.com/${handle(c.instagram)}`],
    ].filter((r) => r[1]);
    box.hidden = rows.length === 0;
    for (const [label, value, href] of rows) {
      box.append(h('div', { class: 'contact-row' },
        h('span', { class: 'muted' }, label === 'tel' ? '☎' : label),
        h('a', { class: 'mono', href, target: href.startsWith('http') ? '_blank' : null, rel: 'noopener' }, value),
        copyButton(value),
      ));
    }
  }

  function copyButton(value) {
    const btn = h('button', { type: 'button', class: 'btn btn-quiet btn-sm' }, t('copy'));
    btn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(value);
        btn.textContent = t('copied');
        setTimeout(() => { btn.textContent = t('copy'); }, 1600);
      } catch { /* clipboard refused: the value stays selectable */ }
    });
    return btn;
  }

  // ---------- booking ----------

  function setMaster(id) {
    state.master = id;
    if (state.date && !slotsOn(state.date).length) state.date = null;
    if (state.slotId && !visible(findSlot(state.slotId) || {})) state.slotId = null;
    state.done = null;
    renderBooking();
  }

  function renderFilter() {
    const root = document.getElementById('master-filter');
    root.textContent = '';
    const all = [{ id: 'all', label: t('booking.allMasters') }]
      .concat(state.config.masters.map((m) => ({ id: m.id, label: local(m.name) })));
    for (const item of all) {
      root.append(h('button', {
        type: 'button', class: 'chip', 'aria-pressed': String(state.master === item.id),
        onclick: () => setMaster(item.id),
      }, item.label));
    }
  }

  function renderSteps() {
    const step = state.done ? 4 : state.slotId ? 3 : state.date ? 2 : 1;
    document.querySelectorAll('#steps li').forEach((li, i) => {
      li.classList.toggle('is-done', i + 1 < step);
      li.classList.toggle('is-current', i + 1 === step);
    });
  }

  function renderCalendar() {
    const root = document.getElementById('calendar');
    if (state.loadError) {
      root.textContent = '';
      root.append(h('p', { class: 'alert alert-error' }, t('err.load')));
      return;
    }
    const todayMonth = state.today.slice(0, 7);
    Cal.render(root, {
      month: state.month,
      locale: locale(),
      today: state.today,
      selected: state.date,
      minMonth: todayMonth,
      maxMonth: Cal.addMonths(todayMonth, MONTHS_AHEAD),
      labels: { prev: t('cal.prev'), next: t('cal.next') },
      info: (date) => {
        const n = slotsOn(date).length;
        return n
          ? { cls: 'has', marks: [{ text: String(n) }], label: t('booking.slots', { n }) }
          : { disabled: true };
      },
      onSelect: (date) => {
        state.date = date;
        state.slotId = null;
        state.done = null;
        state.formError = '';
        renderBooking();
      },
      onMonth: async (month) => {
        state.month = month;
        try {
          await loadMonth(month);
        } catch {
          state.loadError = true;
        }
        renderBooking();
      },
    });
  }

  function renderSheet() {
    const sheet = document.getElementById('sheet');
    sheet.textContent = '';
    if (state.loadError) return;

    if (state.done) {
      sheet.append(doneCard(state.done));
      return;
    }

    if (state.formError && !state.slotId) sheet.append(h('p', { class: 'alert alert-error', role: 'alert' }, state.formError));

    if (!state.date) {
      const next = nearestSlot();
      const monthHasSlots = (state.months.get(state.month) || []).some(visible);
      sheet.append(h('div', { class: 'sheet-empty' },
        h('p', null, next ? (monthHasSlots ? t('booking.pickDay') : t('booking.noneMonth')) : t('booking.noneSoon')),
        next ? h('button', {
          type: 'button', class: 'btn btn-primary',
          onclick: () => {
            state.month = next.date.slice(0, 7);
            state.date = next.date;
            state.slotId = next.id;
            state.formError = '';
            renderBooking();
            focusForm();
          },
        }, `${t('booking.nearest')}: ${shortDate(next.date)}, ${next.time}`) : null,
      ));
      return;
    }

    const slots = slotsOn(state.date);
    sheet.append(h('h3', { class: 'sheet-title' }, longDate(state.date)));
    if (!slots.length) {
      sheet.append(h('p', { class: 'sheet-empty' }, t('booking.noneDay')));
      return;
    }
    sheet.append(h('div', { class: 'times', role: 'group', 'aria-label': t('booking.step2') },
      slots.map((s) => h('button', {
        type: 'button', class: 'time', 'aria-pressed': String(s.id === state.slotId),
        onclick: () => {
          state.slotId = s.id;
          state.formError = '';
          state.fieldErrors = [];
          renderBooking();
          focusForm();
        },
      },
      h('b', null, s.time),
      h('span', null, `${t('booking.until', { time: Cal.endTime(s.time, s.duration) })} · ${masterName(s.masterId)}`))),
    ));

    const slot = state.slotId && findSlot(state.slotId);
    if (slot) sheet.append(bookingForm(slot));
  }

  function field(name, label, control, opts = {}) {
    const hasError = state.fieldErrors.includes(name);
    return h('div', { class: `field${opts.full ? ' full' : ''}${hasError ? ' has-error' : ''}` },
      h('label', { for: `f-${name}` }, label, opts.optional ? h('span', { class: 'opt' }, ` · ${t('form.optional')}`) : null),
      control,
      opts.hint ? h('span', { class: 'hint' }, opts.hint) : null,
      hasError ? h('span', { class: 'err', id: `f-${name}-err` }, t(`err.${name}`)) : null,
    );
  }

  function bookingForm(slot) {
    const bind = (key) => (e) => { draft[key] = e.target.value; };
    const invalid = (key) => (state.fieldErrors.includes(key) ? 'true' : null);

    const name = h('input', { id: 'f-name', name: 'name', autocomplete: 'name', required: true, maxlength: '60', value: draft.name, oninput: bind('name'), 'aria-invalid': invalid('name') });
    const phone = h('input', { id: 'f-phone', name: 'phone', type: 'tel', inputmode: 'tel', autocomplete: 'tel', required: true, maxlength: '30', placeholder: '+84 ', value: draft.phone, oninput: bind('phone'), 'aria-invalid': invalid('phone') });
    const handle = h('input', { id: 'f-handle', name: 'handle', maxlength: '60', value: draft.handle, oninput: bind('handle') });

    const service = h('select', { id: 'f-serviceId', name: 'serviceId', required: true, onchange: bind('serviceId'), 'aria-invalid': invalid('serviceId') },
      h('option', { value: '' }, t('form.servicePick')),
      state.config.services.map((s) => h('option', { value: s.id }, local(s.name))));
    service.value = draft.serviceId;

    const length = h('select', { id: 'f-length', name: 'length', onchange: bind('length') },
      h('option', { value: '' }, t('form.lengthAny')),
      state.config.lengths.map((cm) => h('option', { value: String(cm) }, `${cm} ${state.lang === 'ru' ? 'см' : 'cm'}`)));
    length.value = draft.length;

    const comment = h('textarea', { id: 'f-comment', name: 'comment', maxlength: '500', placeholder: t('form.commentPh'), oninput: bind('comment') });
    comment.value = draft.comment;

    const messengers = h('div', { class: 'chips', role: 'radiogroup', 'aria-labelledby': 'f-messenger-label' },
      MESSENGERS.map((m) => h('button', {
        type: 'button', class: 'chip', role: 'radio', 'aria-checked': String(draft.messenger === m),
        onclick: (e) => {
          draft.messenger = m;
          e.currentTarget.parentNode.querySelectorAll('.chip').forEach((c) => c.setAttribute('aria-checked', String(c === e.currentTarget)));
        },
      }, t(`messenger.${m}`))));

    const honeypot = h('input', { id: 'f-company', name: 'company', tabindex: '-1', autocomplete: 'off' });

    const submit = h('button', { type: 'submit', class: 'btn btn-primary', disabled: state.sending }, state.sending ? t('form.sending') : t('form.submit'));

    const form = h('form', { class: 'form', id: 'booking-form', novalidate: true, onsubmit: (e) => send(e, slot, honeypot) },
      h('div', { class: 'form-summary' },
        h('span', { class: 'eyebrow' }, t('form.for')),
        h('strong', null, `${shortDate(slot.date)}, ${slot.time}–${Cal.endTime(slot.time, slot.duration)}`),
        h('span', { class: 'muted' }, masterName(slot.masterId)),
      ),
      h('div', { class: 'fields' },
        field('name', t('form.name'), name),
        field('phone', t('form.phone'), phone, { hint: t('form.phoneHint') }),
        h('div', { class: 'field full' }, h('span', { class: 'label', id: 'f-messenger-label' }, t('form.messenger')), messengers),
        field('handle', t('form.handle'), handle, { optional: true }),
        field('serviceId', t('form.service'), service),
        field('length', t('form.length'), length, { optional: true }),
        field('comment', t('form.comment'), comment, { optional: true, full: true }),
      ),
      h('div', { class: 'hp', 'aria-hidden': 'true' }, h('label', { for: 'f-company' }, 'Company'), honeypot),
      state.formError ? h('p', { class: 'alert alert-error', role: 'alert' }, state.formError) : null,
      h('div', { class: 'form-actions' }, submit, h('p', null, t('form.note'))),
    );
    return form;
  }

  function focusForm() {
    const form = document.getElementById('booking-form');
    if (!form) return;
    const smooth = !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    form.scrollIntoView({ block: 'nearest', behavior: smooth ? 'smooth' : 'auto' });
    const first = form.querySelector('input:not([tabindex="-1"])');
    first?.focus({ preventScroll: true });
  }

  function validate() {
    const errors = [];
    if (draft.name.trim().length < 2) errors.push('name');
    const digits = draft.phone.replace(/\D/g, '');
    if (digits.length < 7 || digits.length > 15) errors.push('phone');
    if (!draft.serviceId) errors.push('serviceId');
    return errors;
  }

  async function send(e, slot, honeypot) {
    e.preventDefault();
    if (state.sending) return;
    state.formError = '';
    state.fieldErrors = validate();
    if (state.fieldErrors.length) {
      renderSheet();
      document.getElementById(`f-${state.fieldErrors[0]}`)?.focus();
      return;
    }

    state.sending = true;
    renderSheet();
    try {
      const data = await api('/api/bookings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          slotId: slot.id,
          name: draft.name,
          phone: draft.phone,
          messenger: draft.messenger,
          handle: draft.handle,
          serviceId: draft.serviceId,
          length: draft.length ? Number(draft.length) : null,
          comment: draft.comment,
          company: honeypot.value,
        }),
      });
      store.set('contact', JSON.stringify({ name: draft.name, phone: draft.phone, messenger: draft.messenger, handle: draft.handle }));
      const list = state.months.get(slot.date.slice(0, 7)) || [];
      state.months.set(slot.date.slice(0, 7), list.filter((s) => s.id !== slot.id));
      state.done = { ...slot, serviceId: draft.serviceId, ...(data.booking || {}) };
      state.slotId = null;
      draft.comment = '';
    } catch (err) {
      if (err.status === 409) {
        state.formError = t('err.taken');
        state.slotId = null;
        try { await loadMonth(slot.date.slice(0, 7), true); } catch { /* keep cached view */ }
      } else if (err.status === 429) {
        state.formError = t('err.rate');
      } else if (err.status === 400 && err.data?.detail) {
        state.fieldErrors = err.data.detail.split(',');
      } else {
        state.formError = t('err.network');
      }
    } finally {
      state.sending = false;
    }
    renderBooking();
    if (state.done) document.getElementById('sheet').scrollIntoView({ block: 'nearest' });
  }

  function doneCard(b) {
    return h('div', { class: 'done', role: 'status' },
      h('h3', null, t('done.title')),
      h('p', null, t('done.text')),
      h('dl', null,
        h('dt', null, t('done.when')), h('dd', null, `${shortDate(b.date)}, ${b.time}–${Cal.endTime(b.time, b.duration)}`),
        h('dt', null, t('done.master')), h('dd', null, masterName(b.masterId)),
        b.serviceId ? [h('dt', null, t('done.service')), h('dd', null, serviceName(b.serviceId))] : null,
      ),
      h('button', {
        type: 'button', class: 'btn btn-ghost',
        onclick: () => { state.done = null; state.date = null; renderBooking(); },
      }, t('done.again')),
    );
  }

  function renderBooking() {
    renderFilter();
    renderSteps();
    renderCalendar();
    renderSheet();
  }

  function renderAll() {
    applyStatic();
    if (!state.config) return;
    renderServices();
    renderMasters();
    renderInfo();
    if (state.today) renderBooking();
  }

  function readContact() {
    try {
      const saved = JSON.parse(store.get('contact') || 'null');
      if (!saved || typeof saved !== 'object') return {};
      const out = {};
      for (const key of ['name', 'phone', 'handle']) if (typeof saved[key] === 'string') out[key] = saved[key];
      if (MESSENGERS.includes(saved.messenger)) out.messenger = saved.messenger;
      return out;
    } catch {
      return {};
    }
  }

  // ---------- start ----------

  async function init() {
    for (const btn of document.querySelectorAll('[data-lang]')) {
      btn.addEventListener('click', () => {
        state.lang = btn.dataset.lang;
        store.set('lang', state.lang);
        renderAll();
      });
    }
    applyStatic();

    try {
      state.config = await api('/api/config');
      renderAll();
      const guess = new Date().toISOString().slice(0, 7);
      await loadMonth(guess);
      const todayMonth = state.today.slice(0, 7);
      state.month = todayMonth;
      await Promise.all([loadMonth(todayMonth), loadMonth(Cal.addMonths(todayMonth, 1))]);
    } catch {
      state.loadError = true;
      state.today = state.today || new Date().toISOString().slice(0, 10);
      state.month = state.today.slice(0, 7);
    }
    if (state.config) renderAll();
    else document.getElementById('calendar').replaceChildren(h('p', { class: 'alert alert-error' }, t('err.load')));
  }

  init();
})();
