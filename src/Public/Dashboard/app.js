const cardsContainer = document.getElementById('cards-container');

const cardData = [
  { title: "Reception AI", description: "Handles incoming client requests automatically." },
  { title: "Analytics", description: "Tracks interactions and generates reports." },
  { title: "Notifications", description: "Alerts staff about urgent messages." },
  { title: "Settings", description: "Configure AI preferences and responses." }
];

cardData.forEach(data => {
  const card = document.createElement('div');
  card.classList.add('card');

  const h2 = document.createElement('h2');
  h2.textContent = data.title;

  const p = document.createElement('p');
  p.textContent = data.description;

  card.appendChild(h2);
  card.appendChild(p);
  cardsContainer.appendChild(card);
});
