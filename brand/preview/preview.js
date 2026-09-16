'use strict';

const demo = document.querySelector('#calendar-demo');
const themeButtons = document.querySelectorAll('[data-set-theme]');
themeButtons.forEach((button) =>
  button.addEventListener('click', () => {
    demo.dataset.theme = button.dataset.setTheme;
    themeButtons.forEach((item) => item.setAttribute('aria-pressed', String(item === button)));
  }),
);

const status = document.querySelector('#copy-status');
let statusTimer;
document.querySelectorAll('[data-color]').forEach((button) =>
  button.addEventListener('click', async () => {
    const color = button.dataset.color;
    try {
      await navigator.clipboard.writeText(color);
      status.textContent = `Copied ${color}`;
    } catch {
      status.textContent = `Color: ${color} — select the hex value to copy it.`;
    }
    status.classList.add('visible');
    clearTimeout(statusTimer);
    statusTimer = setTimeout(() => status.classList.remove('visible'), 2800);
  }),
);

const mini = document.querySelector('.mini-calendar');
// Monday-first September 2026: Sep 1 is Tuesday.
[31, ...Array.from({ length: 30 }, (_, i) => i + 1), 1, 2, 3, 4].forEach((number, index) => {
  const day = document.createElement('b');
  day.textContent = number;
  if (index === 0 || index > 30) {
    day.className = 'muted';
  }
  if (index === 24) {
    day.className = 'active';
  }
  mini.append(day);
});

const form = document.querySelector('#event-form');
const title = document.querySelector('#event-title');
const start = document.querySelector('#event-start');
const end = document.querySelector('#event-end');
const calendar = document.querySelector('#event-calendar');
const event = document.querySelector('#selected-event');
const editorStatus = document.querySelector('#editor-status');
const eventLabel = document.querySelector('#event-label');
const eventTime = document.querySelector('#event-time');
function timeLabel(value) {
  return `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`;
}
for (let minute = 540; minute <= 900; minute += 15) {
  [start, end].forEach((select) => {
    if (select === start && minute === 900) {
      return;
    }
    const option = document.createElement('option');
    option.value = minute;
    option.textContent = timeLabel(minute);
    option.defaultSelected =
      (select === start && minute === 600) || (select === end && minute === 660);
    select.append(option);
  });
}
function applyEvent(name, from, to, color) {
  eventLabel.textContent = name;
  eventTime.textContent = `${timeLabel(from)}–${timeLabel(to)}`;
  event.className = `event ${color}-event selected-event`;
  event.style.top = `${((from - 540) / 60) * 70}px`;
  event.style.height = `${((to - from) / 60) * 70}px`;
  event.setAttribute('aria-label', `Edit ${name}, ${eventTime.textContent}`);
  document.querySelector('.editor-dot').className = `editor-dot ${color}-dot`;
}
event.addEventListener('click', () => {
  title.focus();
  title.select();
});
form.addEventListener('submit', (e) => {
  e.preventDefault();
  const name = title.value.trim();
  if (!name || Number(end.value) <= Number(start.value)) {
    editorStatus.textContent = !name
      ? 'Add a title for the event.'
      : 'End time must be after the start time.';
    editorStatus.classList.add('error');
    (!name ? title : end).focus();
    return;
  }
  applyEvent(name, Number(start.value), Number(end.value), calendar.value);
  editorStatus.classList.remove('error');
  editorStatus.textContent = 'Saved in this preview.';
});
form.addEventListener('reset', () => {
  applyEvent('Design review', 600, 660, 'lilac');
  editorStatus.classList.remove('error');
  editorStatus.textContent = 'Restored the sample event.';
});
