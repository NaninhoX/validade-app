'use strict';
// Base para usar o app em modo avião: banco local (IndexedDB), catálogo de produtos no aparelho e "preparar para ficar offline".
// O que é feito sem rede fica numa fila no aparelho e sobe sozinho quando a internet voltar (cada lançamento tem um client_id,
// então reenviar nunca soma duas vezes).

// pequeno armazém chave-valor em IndexedDB (o catálogo de 15 mil produtos não cabe com folga no localStorage)
const Local = (() => {
  let abrindo = null;
  const abre = () => abrindo || (abrindo = new Promise((ok, erro) => {
    if (!window.indexedDB) return erro(new Error('sem IndexedDB'));
    const r = indexedDB.open('validade', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => ok(r.result);
    r.onerror = () => erro(r.error);
  }));
  const tx = async (modo, fn) => {
    const db = await abre();
    return new Promise((ok, erro) => {
      const t = db.transaction('kv', modo), req = fn(t.objectStore('kv'));
      t.oncomplete = () => ok(req && req.result);
      t.onerror = () => erro(t.error);
    });
  };
  return {
    get: async k => { try { return await tx('readonly', s => s.get(k)); } catch { return lsGet('kv:' + k, undefined); } },
    set: async (k, v) => { try { await tx('readwrite', s => s.put(v, k)); } catch { lsSet('kv:' + k, v); } },
  };
})();

// catálogo de produtos (EAN, nome, preço) guardado no aparelho: dá o nome do produto sem internet
const Catalogo = (() => {
  let mapa = null, carregando = null;
  const chave = ean => String(ean || '').replace(/\D/g, '').replace(/^0+/, '');
  const monta = itens => { mapa = new Map(); for (const [e, n, p] of itens) mapa.set(chave(e), { ean: e, nome: n, preco: p }); };

  function carrega() {
    carregando = carregando || Local.get('catalogo').then(itens => { if (Array.isArray(itens)) monta(itens); return mapa ? mapa.size : 0; });
    return carregando;
  }
  const get = ean => (mapa ? mapa.get(chave(ean)) || null : null);
  const tamanho = () => (mapa ? mapa.size : 0);

  // baixa o catálogo quando mudou (o servidor responde "igual" se a versão guardada ainda vale)
  async function atualiza({ forcar = false } = {}) {
    await carrega();
    if (!navigator.onLine) return { ok: false, motivo: 'sem rede' };
    const v = lsGet('catV', null);
    const r = await api('/api/catalogo' + (v && mapa && !forcar ? '?v=' + encodeURIComponent(v) : ''), { tentativas: 0 });
    if (r.igual) { lsSet('catQuando', Date.now()); return { ok: true, igual: true, total: tamanho() }; }
    await Local.set('catalogo', r.itens);
    lsSet('catV', r.v); lsSet('catQuando', Date.now());
    monta(r.itens);
    return { ok: true, igual: false, total: r.itens.length };
  }
  return { carrega, get, tamanho, atualiza };
})();

const Offline = (() => {
  // ensina o aparelho a trabalhar sem rede: catálogo, lista de endereços e os endereços da ronda de hoje
  async function preparar({ aviso = true } = {}) {
    if (!navigator.onLine) { if (aviso) toast('Conecte-se à internet para preparar o modo avião', 'bad', 4000); return false; }
    const rel = { catalogo: 0, enderecos: 0, ronda: 0 };
    try {
      rel.catalogo = (await Catalogo.atualiza()).total;
      const ends = await api('/api/enderecos'); const lista = ends.map(e => e.endereco).filter(Boolean);
      lsSet('enderecos', lista); rel.enderecos = lista.length;
      const t = lsGet('turno', null);                                      // endereços da ronda do dia: ficam guardados com os lotes
      if (t && t.itens) for (const it of t.itens) { try { await Local.set('end:' + it.e, await api('/api/enderecos/' + encodeURIComponent(it.e))); rel.ronda++; } catch { /* segue */ } }
      lsSet('offlinePronto', { em: Date.now(), ...rel });
      if (aviso) toast(`Pronto para o modo avião: ${rel.catalogo.toLocaleString('pt-BR')} produtos${rel.ronda ? ' e ' + rel.ronda + ' endereços da ronda' : ''}`, 'ok', 5000);
      return true;
    } catch (e) { if (aviso) toast(e.message, 'bad', 5000); return false; }
  }
  const pronto = () => lsGet('offlinePronto', null);
  return { preparar, pronto };
})();

// ao abrir, carrega o catálogo do aparelho e, com rede, confere se há novidade (no máximo uma vez por dia)
(async () => {
  try {
    await Catalogo.carrega();
    const q = lsGet('catQuando', 0);
    if (navigator.onLine && Date.now() - q > 24 * 3600 * 1000) Catalogo.atualiza().catch(() => {});
  } catch { /* segue sem catálogo */ }
})();
