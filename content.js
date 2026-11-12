(() => {
  'use strict';

  // Прячем форму сайта сразу (см. content.css), чтобы старая таблица не мигала при загрузке
  const html = document.documentElement;
  html.classList.add('gx-on');

  const FORM = '#inside_student_tasks_index';
  const TASK_HREF = /\/inside\/student\/tasks\/(\d+)/;
  const COLORS = ['1', '2', '3'];
  const COLOR_TITLES = { 1: 'Красный', 2: 'Жёлтый', 3: 'Зелёный' };
  const DAY = 24 * 60 * 60 * 1000;
  const PER_PAGE = 100; // максимум, который умеет сайт

  // Всё, что хранится в расширении (chrome.storage.local):
  //   hidden:    { [taskId]: true }             — скрытые работы
  //   colors:    { [taskId]: '1' | '2' | '3' }  — цветные пометки
  //   collapsed: { [subjectKey]: true }         — свёрнутые предметы
  //   nums:      { [taskId]: '3' }              — исправленные номера работ
  const state = { hidden: {}, colors: {}, collapsed: {}, nums: {} };
  const KEYS = Object.keys(state);

  // Комментарии преподавателей. Это не настройки, а кэш со страниц работ,
  // поэтому он лежит отдельно, под ключом COMMENTS_KEY:
  //   { [taskId]: { changed: 'дата изменения из списка', at: время загрузки, list: [...] } }
  const COMMENTS_KEY = 'comments';
  const COMMENTS_TTL = 6 * 60 * 60 * 1000; // даже без изменений перепроверяем раз в 6 часов
  let comments = {};

  let tasks = []; // все работы семестра
  let showHidden = false;
  let query = '';
  let notice = '';
  let ui = null; // { summary, hiddenInfo, hiddenText, toggle, view }

  const save = () => chrome.storage.local.set({ ...state });

  // ---------- маленькие помощники ----------

  function h(tag, cls, ...kids) {
    const el = document.createElement(tag);
    if (cls) el.className = cls;
    el.append(...kids.filter((k) => k != null && k !== ''));
    return el;
  }

  function makeButton(cls, onClick, label) {
    const b = h('button', cls, label);
    b.type = 'button';
    b.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      onClick();
    });
    return b;
  }

  const text = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : '');

  function plural(n, one, few, many) {
    const d = n % 10;
    const dd = n % 100;
    if (d === 1 && dd !== 11) return one;
    if (d >= 2 && d <= 4 && (dd < 12 || dd > 14)) return few;
    return many;
  }

  function today() {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d;
  }

  // ---------- чтение таблицы сайта ----------

  function taskId(row) {
    const link = row.querySelector('a[href*="/inside/student/tasks/"]');
    const m = link && TASK_HREF.exec(link.getAttribute('href'));
    return m ? m[1] : null;
  }

  // Номера колонок ищем по заголовкам, чтобы не сломаться, если их переставят
  function columnMap(table) {
    const fallback = { subject: 1, num: 2, title: 3, status: 4, points: 5, type: 6, deadline: 7, changed: 8, teacher: 9 };
    const patterns = {
      subject: /дисциплин/i,
      num: /№/,
      title: /назван/i,
      status: /статус/i,
      points: /балл/i,
      type: /тип/i,
      deadline: /предельн/i,
      changed: /изменен/i,
      teacher: /преподават/i,
    };
    const heads = table.tHead ? [...table.tHead.rows[0].cells].map(text) : [];
    const map = {};
    for (const key of Object.keys(patterns)) {
      const i = heads.findIndex((t) => patterns[key].test(t));
      map[key] = i >= 0 ? i : fallback[key];
    }
    return map;
  }

  const isAccepted = (status) => /принят/i.test(status) && !/не\s*принят/i.test(status);

  function parseRow(row, col) {
    const cell = (key) => row.cells[col[key]];
    const subjectLink = cell('subject') && cell('subject').querySelector('a');
    const titleLink = cell('title') && cell('title').querySelector('a');
    const teacherLink = cell('teacher') && cell('teacher').querySelector('a');
    const subjectName = text(cell('subject')) || 'Без предмета';
    const subjectHref = subjectLink ? subjectLink.getAttribute('href') : null;
    const subjectId = subjectHref && /(\d+)\/?$/.exec(subjectHref);
    const points = /(-?\d+(?:[.,]\d+)?)\s*\/\s*(-?\d+(?:[.,]\d+)?)/.exec(text(cell('points')));
    const date = /(\d{2})\.(\d{2})\.(\d{4})/.exec(text(cell('deadline')));
    const statusText = text(cell('status'));
    const id = taskId(row);
    const task = {
      id,
      subject: { key: subjectId ? subjectId[1] : subjectName, name: subjectName, href: subjectHref },
      siteNum: text(cell('num')),
      title: text(cell('title')),
      href: titleLink ? titleLink.getAttribute('href') : '/inside/student/tasks/' + id,
      statusText,
      statusBadge: cell('status') ? cell('status').querySelector('.badge') : null,
      // «не принят» тоже содержит слово «принят», поэтому проверяем отдельно
      accepted: isAccepted(statusText),
      // отклонённую работу надо переделывать, так что она считается несданной
      submitted: isAccepted(statusText) || /ожидает/i.test(statusText),
      pointsText: text(cell('points')),
      got: points ? parseFloat(points[1].replace(',', '.')) : 0,
      max: points ? parseFloat(points[2].replace(',', '.')) : 0,
      type: text(cell('type')),
      deadlineText: text(cell('deadline')),
      deadline: date ? new Date(+date[3], +date[2] - 1, +date[1]) : null,
      changed: text(cell('changed')),
      teacher: text(cell('teacher')),
      teacherHref: teacherLink ? teacherLink.getAttribute('href') : null,
    };
    task.search = [task.title, task.subject.name, task.type, task.teacher].join(' ').toLowerCase();
    return task;
  }

  function readTasks(doc) {
    const table = doc.querySelector(FORM + ' table');
    if (!table) return [];
    const col = columnMap(table);
    return [...table.querySelectorAll('tbody tr')].filter(taskId).map((row) => parseRow(row, col));
  }

  function totalOf(doc) {
    const m = /Всего\s+(\d+)/.exec(text(doc.querySelector(FORM + ' .table__footer')));
    return m ? +m[1] : null;
  }

  // Сайт отдаёт работы страницами и с фильтрами. Нам нужен весь семестр целиком,
  // поэтому, если на странице не всё, тихо догружаем остальное.
  function pageIsComplete(form, count) {
    const total = totalOf(document);
    if (total !== null && total > count) return false;
    for (const name of ['subject', 'type', 'showStatus']) {
      const sel = form.querySelector('select[name="' + name + '"]');
      if (sel && sel.value !== '0' && sel.value !== '') return false;
    }
    const search = form.querySelector('input[name="text"]');
    return !(search && search.value.trim());
  }

  async function fetchAll(form, semester) {
    const get = async (page) => {
      const url = new URL(form.getAttribute('action') || location.pathname, location.href);
      url.search = '';
      if (semester) url.searchParams.set('semester', semester);
      url.searchParams.set('perPage', PER_PAGE);
      if (page > 1) url.searchParams.set('page', page);
      const res = await fetch(url, { credentials: 'same-origin' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return new DOMParser().parseFromString(await res.text(), 'text/html');
    };
    const first = await get(1);
    const all = readTasks(first);
    const pages = Math.min(20, Math.ceil((totalOf(first) || all.length) / PER_PAGE));
    for (let p = 2; p <= pages; p++) all.push(...readTasks(await get(p)));
    const seen = new Set();
    return all.filter((t) => !seen.has(t.id) && seen.add(t.id));
  }

  // ---------- комментарии преподавателя ----------

  // На странице работы есть таблица отчётов с колонкой «Комментарий преподавателя»
  function readComments(doc) {
    const th = [...doc.querySelectorAll('th')].find((t) => /комментарий преподавателя/i.test(t.textContent));
    if (!th) return [];
    const heads = [...th.parentElement.cells].map(text);
    const col = (re) => heads.findIndex((t) => re.test(t));
    const ci = heads.indexOf(text(th));
    const si = col(/статус/i);
    const di = col(/дата проверки/i);
    const list = [];
    for (const row of th.closest('table').querySelectorAll('tbody tr')) {
      if (row.cells.length !== heads.length) continue; // строка «Отчетов не найдено»
      const cell = row.cells[ci].cloneNode(true);
      cell.querySelectorAll('br').forEach((br) => br.replaceWith('\n')); // переносы строк сохраняем
      const comment = cell.textContent.replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim();
      if (!comment) continue;
      const status = si >= 0 ? text(row.cells[si]).replace(/\s*\d+([.,]\d+)?\s*балл\S*/i, '') : '';
      const date = di >= 0 ? /(\d{2})\.(\d{2})\.(\d{4})/.exec(text(row.cells[di])) : null;
      const time = di >= 0 ? /(\d{1,2}):(\d{2})/.exec(text(row.cells[di])) : null;
      list.push({
        text: comment,
        status,
        accepted: isAccepted(status),
        date: date ? date[0] : '',
        sort: date ? +new Date(+date[3], +date[2] - 1, +date[1], time ? +time[1] : 0, time ? +time[2] : 0) : 0,
      });
    }
    return list.sort((a, b) => b.sort - a.sort); // свежие сверху
  }

  // Подгружаем страницы работ по несколько штук за раз и только те,
  // что изменились с прошлого раза (по колонке «Дата изменения»).
  async function loadComments() {
    const now = Date.now();
    const stale = tasks.filter((t) => {
      const c = comments[t.id];
      return !c || c.changed !== t.changed || now - c.at > COMMENTS_TTL;
    });
    if (!stale.length) return;

    let i = 0;
    const worker = async () => {
      while (i < stale.length) {
        const task = stale[i++];
        try {
          const res = await fetch(new URL(task.href, location.href), { credentials: 'same-origin' });
          if (!res.ok) continue;
          const doc = new DOMParser().parseFromString(await res.text(), 'text/html');
          comments[task.id] = { changed: task.changed, at: Date.now(), list: readComments(doc) };
        } catch (e) {
          // нет сети и т. п. — попробуем при следующем открытии
        }
      }
    };
    await Promise.all([worker(), worker(), worker(), worker()]);
    chrome.storage.local.set({ [COMMENTS_KEY]: comments });
    render();
  }

  // Если работу уже приняли, старые замечания к непринятым попыткам больше не нужны
  function commentsOf(task) {
    const list = (comments[task.id] && comments[task.id].list) || [];
    return task.accepted ? list.filter((c) => c.accepted) : list;
  }

  function commentsNode(task) {
    const list = commentsOf(task);
    if (!list.length) return null;
    return h(
      'div',
      'gx-comments',
      ...list.map((c, i) => {
        const meta = h('span', 'gx-comment-meta', [c.status, c.date].filter(Boolean).join(' · '));
        return h(
          'div',
          'gx-comment' + (c.accepted ? ' gx-comment-ok' : ' gx-comment-bad') + (i > 0 ? ' gx-comment-old' : ''),
          h('i', 'fa fa-solid fa-comment-dots'),
          h('div', 'gx-comment-body', h('div', 'gx-comment-text', c.text), meta)
        );
      })
    );
  }

  const commentText = (task) =>
    commentsOf(task)
      .map((c) => c.text.toLowerCase())
      .join(' ');

  // ---------- выпадающее меню цветов ----------

  // Одно общее меню на всю страницу. Оно лежит прямо в <body> с position: fixed,
  // чтобы его не обрезали рамки блоков.
  let menu = null;
  let menuAnchor = null;

  function closeMenu() {
    if (!menu || menu.hidden) return;
    menu.hidden = true;
    menuAnchor = null;
  }

  function setColor(id, c) {
    if (c) state.colors[id] = c;
    else delete state.colors[id];
    save();
    closeMenu();
    render();
  }

  function openMenu(anchor, id) {
    if (menuAnchor === anchor) return closeMenu(); // повторный клик по кнопке — закрыть
    const current = state.colors[id];
    const item = (c, label) => {
      const swatch = h('span', 'gx-swatch');
      if (c) swatch.dataset.c = c;
      const b = makeButton('gx-menu-item' + ((c || '') === (current || '') ? ' gx-current' : ''), () => setColor(id, c));
      b.append(swatch, label);
      return b;
    };
    menu.replaceChildren(...COLORS.map((c) => item(c, COLOR_TITLES[c])), item(null, 'Без цвета'));

    // фон и цвет текста берём у страницы, чтобы меню подходило и к тёмной, и к светлой теме
    const page = getComputedStyle(document.body);
    const transparent = /^(transparent|rgba\(.*,\s*0\))$/.test(page.backgroundColor);
    menu.style.background = transparent ? '#fff' : page.backgroundColor;
    menu.style.color = page.color;

    menu.hidden = false;
    menuAnchor = anchor;
    const r = anchor.getBoundingClientRect();
    const w = menu.offsetWidth;
    const hgt = menu.offsetHeight;
    const below = r.bottom + 4;
    menu.style.left = Math.max(8, Math.min(r.right - w, window.innerWidth - w - 8)) + 'px';
    menu.style.top = (below + hgt > window.innerHeight - 8 ? Math.max(8, r.top - hgt - 4) : below) + 'px';
  }

  function buildMenu() {
    menu = h('div', 'gx-root gx-menu');
    menu.hidden = true;
    document.body.append(menu);
    document.addEventListener(
      'mousedown',
      (e) => {
        if (!menu.contains(e.target) && !(e.target.closest && e.target.closest('.gx-color'))) closeMenu();
      },
      true
    );
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closeMenu();
    });
    window.addEventListener('scroll', closeMenu, true);
    window.addEventListener('resize', closeMenu);
  }

  // ---------- строка работы ----------

  function makeControls(id) {
    const c = state.colors[id];
    const isHidden = !!state.hidden[id];

    const color = makeButton('gx-color', () => openMenu(color, id));
    const swatch = h('span', 'gx-swatch');
    if (c) swatch.dataset.c = c;
    color.append(swatch);
    color.title = c ? 'Цвет: ' + COLOR_TITLES[c].toLowerCase() + '. Нажмите, чтобы изменить' : 'Пометить цветом';

    const hide = makeButton('gx-hide', () => {
      closeMenu();
      if (state.hidden[id]) delete state.hidden[id];
      else state.hidden[id] = true;
      save();
      render();
    });
    hide.append(h('i', 'fa fa-solid ' + (isHidden ? 'fa-rotate-left' : 'fa-eye-slash')));
    hide.title = isHidden ? 'Вернуть в список' : 'Скрыть работу';

    return h('div', 'gx-ctl', color, hide);
  }

  const numOf = (task) => (state.nums[task.id] !== undefined ? state.nums[task.id] : task.siteNum);

  // Номер работы: клик превращает его в поле ввода
  function numNode(task) {
    const num = numOf(task);
    const edited = state.nums[task.id] !== undefined;
    const box = h('div', 'gx-num', num !== '' ? '№' + num : '№—');
    box.title = (edited ? 'На сайте: №' + task.siteNum + '. ' : '') + 'Нажмите, чтобы изменить номер';
    box.addEventListener('click', () => {
      const input = h('input', 'gx-num-input');
      input.type = 'text';
      input.inputMode = 'numeric';
      input.maxLength = 4;
      input.value = num;
      let done = false;
      const finish = (commit) => {
        if (done) return;
        done = true;
        if (commit) {
          const value = input.value.trim();
          // пусто или как на сайте — убираем исправление
          if (value === '' || value === task.siteNum) delete state.nums[task.id];
          else state.nums[task.id] = value;
          save();
        }
        render();
      };
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') finish(true);
        else if (e.key === 'Escape') finish(false);
      });
      input.addEventListener('blur', () => finish(true));
      box.replaceWith(input);
      input.focus();
      input.select();
    });
    return box;
  }

  function deadlineNode(task) {
    const box = h('div', 'gx-deadline');
    if (!task.deadline) {
      box.append(h('span', 'gx-muted', 'без срока'));
      return box;
    }
    box.append(h('span', 'gx-date', task.deadlineText));
    if (task.submitted) return box;

    const days = Math.round((task.deadline - today()) / DAY);
    let hint;
    let cls = 'gx-muted';
    if (days < 0) {
      hint = 'просрочено на ' + -days + ' ' + plural(-days, 'день', 'дня', 'дней');
      cls = 'gx-late';
    } else if (days === 0) {
      hint = 'сегодня';
      cls = 'gx-soon';
    } else {
      hint = 'через ' + days + ' ' + plural(days, 'день', 'дня', 'дней');
      if (days <= 7) cls = 'gx-soon';
    }
    box.append(h('span', 'gx-hint ' + cls, hint));
    return box;
  }

  function taskCard(task) {
    const title = h('a', 'gx-title', task.title);
    title.href = task.href;

    const meta = h('div', 'gx-meta', task.type);
    if (task.teacher) {
      const teacher = h(task.teacherHref ? 'a' : 'span', '', task.teacher);
      if (task.teacherHref) teacher.href = task.teacherHref;
      meta.append(task.type ? ' · ' : '', teacher);
    }

    const status = h('div', 'gx-status');
    if (task.statusBadge) status.append(task.statusBadge.cloneNode(true));
    else status.append(h('span', 'gx-muted', /^[—–-]?$/.test(task.statusText) ? 'не сдано' : task.statusText));

    const c = state.colors[task.id];
    return h(
      'div',
      'gx-task' + (c ? ' gx-c' + c : '') + (state.hidden[task.id] ? ' gx-hidden' : ''),
      numNode(task),
      h('div', 'gx-main', title, meta, commentsNode(task)),
      status,
      h('div', 'gx-points', task.pointsText),
      deadlineNode(task),
      makeControls(task.id)
    );
  }

  // ---------- блок предмета ----------

  function subjectSection(subject, list) {
    const counted = list.filter((t) => !state.hidden[t.id]);
    const accepted = counted.filter((t) => t.accepted).length;
    const got = counted.reduce((s, t) => s + t.got, 0);
    const max = counted.reduce((s, t) => s + t.max, 0);
    const collapsed = !query && !!state.collapsed[subject.key]; // при поиске показываем всё найденное

    const stat = h(
      'span',
      'gx-subj-stat',
      'принято ' + accepted + ' из ' + counted.length + (max ? ' · ' + got + ' / ' + max + ' б.' : '')
    );
    const progress = h('span', 'gx-progress', h('i'));
    progress.firstChild.style.width = (counted.length ? (accepted / counted.length) * 100 : 0) + '%';

    const head = h('div', 'gx-subj-head', h('span', 'gx-caret', '▾'), h('span', 'gx-subj-name', subject.name), stat, progress);
    if (subject.href) {
      const link = h('a', 'gx-subj-link', 'к предмету');
      link.href = subject.href;
      link.addEventListener('click', (e) => e.stopPropagation());
      head.append(link);
    }
    head.addEventListener('click', () => {
      if (state.collapsed[subject.key]) delete state.collapsed[subject.key];
      else state.collapsed[subject.key] = true;
      save();
      render();
    });

    const section = h('section', 'gx-subj' + (collapsed ? ' gx-collapsed' : ''), head);
    if (!collapsed) section.append(h('div', 'gx-tasks', ...list.map(taskCard)));
    return section;
  }

  // ---------- рендер ----------

  function summaryText() {
    const list = tasks.filter((t) => !state.hidden[t.id]);
    if (!list.length) return '';
    const accepted = list.filter((t) => t.accepted).length;
    const waiting = list.filter((t) => t.submitted && !t.accepted).length;
    const todo = list.filter((t) => !t.submitted);
    const now = today();
    const late = todo.filter((t) => t.deadline && t.deadline < now).length;
    const parts = [list.length + ' ' + plural(list.length, 'работа', 'работы', 'работ'), 'принято ' + accepted];
    if (waiting) parts.push('на проверке ' + waiting);
    parts.push('не сдано ' + todo.length + (late ? ' (просрочено ' + late + ')' : ''));
    return parts.join(' · ');
  }

  function render() {
    if (!ui) return;
    closeMenu();

    const hiddenCount = tasks.filter((t) => state.hidden[t.id]).length;
    if (!hiddenCount) showHidden = false;

    const groups = new Map(); // порядок предметов — как на сайте
    for (const task of tasks) {
      if (state.hidden[task.id] && !showHidden) continue;
      if (query && !task.search.includes(query) && !commentText(task).includes(query)) continue;
      if (!groups.has(task.subject.key)) groups.set(task.subject.key, { subject: task.subject, list: [] });
      groups.get(task.subject.key).list.push(task);
    }
    // внутри предмета — по номеру работы; при равных номерах остаётся порядок сайта
    const order = (t) => {
      const n = parseFloat(String(numOf(t)).replace(',', '.'));
      return Number.isNaN(n) ? Infinity : n;
    };
    const sections = [...groups.values()].map((g) => {
      g.list.sort((a, b) => order(a) - order(b) || 0);
      return subjectSection(g.subject, g.list);
    });
    if (!sections.length) {
      const why = !tasks.length
        ? 'В этом семестре заданий нет.'
        : query
          ? 'Ничего не найдено.'
          : 'Все работы скрыты.';
      sections.push(h('div', 'gx-empty', why));
    }
    ui.view.replaceChildren(...sections);

    ui.summary.textContent = notice || summaryText();
    ui.hiddenInfo.hidden = hiddenCount === 0;
    ui.hiddenText.textContent = 'Скрыто: ' + hiddenCount;
    ui.toggle.textContent = showHidden ? 'Спрятать' : 'Показать';
  }

  // ---------- сборка страницы ----------

  function build(form) {
    const toolbar = h('div', 'gx-toolbar');

    // Семестр — единственный выбор, который остаётся от сайта
    const siteSemester = form.querySelector('select[name="semester"]');
    if (siteSemester) {
      const semester = h('select', 'form-select form-select-sm gx-semester');
      semester.title = 'Семестр';
      for (const o of siteSemester.options) semester.add(new Option(text(o), o.value, false, o.selected));
      semester.addEventListener('change', () => {
        const url = new URL(form.getAttribute('action') || location.pathname, location.href);
        url.search = '';
        url.searchParams.set('semester', semester.value);
        location.assign(url);
      });
      toolbar.append(semester);
    }

    const search = h('input', 'form-control form-control-sm gx-search');
    search.type = 'search';
    search.placeholder = 'Поиск по названию, предмету, преподавателю, комментарию';
    search.addEventListener('input', () => {
      query = search.value.trim().toLowerCase();
      render();
    });
    toolbar.append(search);

    ui = {
      summary: h('span', 'gx-summary'),
      hiddenText: h('span'),
      toggle: makeButton('gx-toggle', () => {
        showHidden = !showHidden;
        render();
      }),
      view: h('div', 'gx-view'),
    };
    ui.hiddenInfo = h('div', 'gx-hidden-info', ui.hiddenText, ui.toggle);

    const body = h('div', 'card-body', toolbar, h('div', 'gx-info', ui.summary, ui.hiddenInfo), ui.view);
    form.before(h('div', 'gx-root gx-page card shadow-sm', body));
    buildMenu();
    return siteSemester ? siteSemester.value : '';
  }

  function load(data) {
    for (const key of KEYS) {
      if (data[key] !== undefined) state[key] = data[key];
    }
  }

  function init() {
    const form = document.querySelector(FORM);
    if (!form || !form.querySelector('table')) {
      html.classList.remove('gx-on'); // не список заданий — ничего не трогаем
      return;
    }
    chrome.storage.local.get([...KEYS, COMMENTS_KEY], (data) => {
      load(data);
      comments = data[COMMENTS_KEY] || {};
      const semester = build(form);
      tasks = readTasks(document);
      render(); // сразу показываем то, что есть, вместе с комментариями из кэша

      const ready = pageIsComplete(form, tasks.length)
        ? Promise.resolve()
        : fetchAll(form, semester)
            .then((all) => {
              tasks = all;
              render();
            })
            .catch(() => {
              notice = 'Не удалось загрузить все работы — список может быть неполным.';
              render();
            });
      ready.then(loadComments);
    });

    // Синхронизация между открытыми вкладками
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      const data = {};
      for (const key of KEYS) {
        if (changes[key]) data[key] = changes[key].newValue || {};
      }
      load(data);
      render();
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
