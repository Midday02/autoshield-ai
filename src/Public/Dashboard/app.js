// Пока кликабельные элементы просто показывают alert
// Можно подключить реальный бэкенд позже

document.querySelectorAll('.kpi-card').forEach(card => {
  card.addEventListener('click', () => {
    alert(`${card.querySelector('h3').textContent} clicked`);
  });
});

document.querySelectorAll('.module-card').forEach(card => {
  card.addEventListener('click', () => {
    alert(`${card.querySelector('h3').textContent} clicked`);
  });
});
