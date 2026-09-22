const FULL_POSTCODE = /^[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}$/i;
const OUTWARD_POSTCODE = /^[A-Z]{1,2}\d[A-Z\d]?$/i;
const normalise = (text) => text.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f'’]/g, '').trim();

export function installSearch(nodes, { onSelect, contains }) {
  const input = document.getElementById('search');
  const form = document.getElementById('searchForm');
  const list = document.getElementById('searchResults');
  const status = document.getElementById('searchStatus');
  const submit = document.getElementById('searchSubmit');
  const places = [...new Map(nodes.map((node) => [normalise(node.name), node])).values()];
  const indexed = places.map((node) => ({ node, key: normalise(node.name) }));
  let matches = [];
  let active = -1;
  let controller;
  let version = 0;

  function close() {
    list.hidden = true;
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
    active = -1;
  }

  function cancel() {
    version++;
    controller?.abort();
    controller = null;
    submit.disabled = false;
    input.removeAttribute('aria-busy');
  }

  function message(text, error = false) {
    status.textContent = text;
    status.hidden = !text;
    input.setAttribute('aria-invalid', String(error));
  }

  function reset() {
    cancel();
    close();
    input.value = '';
    message('');
  }

  function select(node) {
    reset();
    onSelect({ lat: node.lat, lon: node.lon, name: node.name, node: node.index });
  }

  function highlight(index) {
    active = index;
    [...list.children].forEach((item, i) => item.setAttribute('aria-selected', String(i === active)));
    if (active >= 0) {
      input.setAttribute('aria-activedescendant', `place-${active}`);
      list.children[active]?.scrollIntoView({ block: 'nearest' });
    }
    else input.removeAttribute('aria-activedescendant');
  }

  function suggest() {
    const query = normalise(input.value);
    matches = query ? indexed.filter(({ key }) => key.includes(query))
      .sort((a, b) => Number(b.key.startsWith(query)) - Number(a.key.startsWith(query)) || a.node.name.localeCompare(b.node.name))
      .slice(0, 6).map(({ node }) => node) : [];
    list.replaceChildren();
    if (!matches.length) { close(); return; }
    matches.forEach((node, i) => {
      const item = document.createElement('li');
      item.id = `place-${i}`;
      item.setAttribute('role', 'option');
      const name = document.createElement('span');
      name.textContent = node.name;
      const kind = document.createElement('small');
      kind.textContent = node.kind === 'station' ? 'Station' : 'Place';
      item.append(name, kind);
      item.addEventListener('pointerdown', (event) => event.preventDefault());
      item.addEventListener('click', () => select(node));
      list.append(item);
    });
    list.hidden = false;
    input.setAttribute('aria-expanded', 'true');
    highlight(0);
  }

  input.addEventListener('input', () => { cancel(); message(''); suggest(); });
  input.addEventListener('focus', suggest);
  input.addEventListener('blur', close);
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') { cancel(); close(); message(''); event.preventDefault(); }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (list.hidden) suggest();
      else if (matches.length) highlight((active + (event.key === 'ArrowDown' ? 1 : -1) + matches.length) % matches.length);
    }
  });
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const text = input.value.trim();
    if (!text) { input.focus(); return; }
    const exact = indexed.find(({ key }) => key === normalise(text));
    const node = exact?.node || matches[Math.max(0, active)];
    if (node) { select(node); return; }
    cancel();
    close();
    const compact = text.replace(/\s+/g, '').toUpperCase();
    const full = FULL_POSTCODE.test(text);
    if (!full && !OUTWARD_POSTCODE.test(compact)) {
      message('No matching place. Try a station, landmark or London postcode.', true);
      return;
    }
    const request = version;
    const lookup = controller = new AbortController();
    const signal = lookup.signal;
    const timeout = setTimeout(() => lookup.abort(), 10000);
    submit.disabled = true;
    input.setAttribute('aria-busy', 'true');
    message(`Finding ${compact}…`);
    try {
      const response = await fetch(`https://api.postcodes.io/${full ? 'postcodes' : 'outcodes'}/${encodeURIComponent(compact)}`, { signal });
      const json = response.ok ? await response.json() : null;
      if (request !== version) return;
      const hit = json?.result;
      if (!hit || !Number.isFinite(hit.latitude) || !Number.isFinite(hit.longitude)) message('Postcode not found. Check it and try again.', true);
      else if (!contains(hit.longitude, hit.latitude)) message('That postcode is outside this map. Try one in London.', true);
      else { reset(); onSelect({ lat: hit.latitude, lon: hit.longitude, name: hit.postcode || hit.outcode, node: -1 }); }
    } catch {
      if (request === version) message('Could not find that postcode. Check your connection and try again.', true);
    } finally {
      clearTimeout(timeout);
      if (request === version) { submit.disabled = false; input.removeAttribute('aria-busy'); }
    }
  });
  return { reset };
}
