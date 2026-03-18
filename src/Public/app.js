async function loadCalls() {
  const res = await fetch('/api/calls');
  const data = await res.json();

  document.getElementById('callsCount').innerText = data.length;

  const container = document.getElementById('calls');
  container.innerHTML = '';

  data.slice(-10).reverse().forEach(call => {
    const el = document.createElement('div');

    el.innerHTML = `
      <div style="padding:10px; border-bottom:1px solid #334155">
        📞 ${call.phone}<br/>
        Intent: ${call.intent}<br/>
        Time: ${call.time}
      </div>
    `;

    container.appendChild(el);
  });
}

setInterval(loadCalls, 3000);
loadCalls();
