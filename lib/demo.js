// Dados de demonstração: produtos de pet shop, lotes espalhados pelas gôndolas com validades variadas, uma ronda e duas baixas.
// Serve para mostrar o sistema a outra filial sem usar o estoque real.
// Uso: DEMO=1 PGLITE_DIR=memory:// npm start      (computador, banco em memória)
//      DEMO_INICIAL=1 na Vercel                   (carrega uma única vez e marca no banco; apague a variável depois)
const S = require('./service');
const U = require('./util');

// gerador pseudoaleatório fixo: a demonstração sai sempre igual
function rng(seed = 11) { return () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646; }

// EAN-13 com dígito verificador certo (prefixo 789 = Brasil)
function ean13(base12) {
  let soma = 0;
  for (let i = 0; i < 12; i++) soma += +base12[i] * (i % 2 ? 3 : 1);
  return base12 + ((10 - (soma % 10)) % 10);
}

const PRODUTOS = [
  ['RAÇÃO SECA PREMIER CÃES ADULTOS 15KG', 'PREMIER', 'RAÇÃO', 219.9], ['RAÇÃO SECA PREMIER GATOS CASTRADOS 7,5KG', 'PREMIER', 'RAÇÃO', 189.9],
  ['RAÇÃO SECA ROYAL CANIN MINI ADULT 7,5KG', 'ROYAL', 'RAÇÃO', 259.9], ['RAÇÃO SECA ROYAL CANIN FELINE LIGHT 4KG', 'ROYAL', 'RAÇÃO', 169.9],
  ['RAÇÃO SECA PRO PLAN CÃES FILHOTES 15KG', 'PRO PLAN', 'RAÇÃO', 239.9], ['RAÇÃO SECA PRO PLAN GATOS ADULTOS FRANGO 3KG', 'PRO PLAN', 'RAÇÃO', 129.9],
  ['RAÇÃO SECA GOLDEN FÓRMULA CÃES ADULTOS 15KG', 'GOLDEN', 'RAÇÃO', 179.9], ['RAÇÃO SECA GOLDEN GATOS CASTRADOS 10KG', 'GOLDEN', 'RAÇÃO', 199.9],
  ['RAÇÃO ÚMIDA PEDIGREE SACHÊ CARNE 100G', 'PEDIGREE', 'RAÇÃO', 3.5], ['RAÇÃO ÚMIDA WHISKAS SACHÊ SALMÃO 85G', 'WHISKAS', 'RAÇÃO', 3.2],
  ['RAÇÃO SECA N&D ANCESTRAL CÃES CORDEIRO 10KG', 'ND', 'RAÇÃO', 349.9], ['RAÇÃO SECA N&D PRIME GATOS FRANGO 1,5KG', 'ND', 'RAÇÃO', 119.9],
  ['PETISCO BIFINHO CARNE 500G', 'KELDOG', 'PETISCO', 29.9], ['PETISCO OSSO NÓ 6" 2UN', 'PET FLEX', 'PETISCO', 19.9],
  ['PETISCO STICKS DENTAL CÃES MÉDIOS 7UN', 'PEDIGREE', 'PETISCO', 22.9], ['PETISCO SNACK GATOS ATUM 40G', 'WHISKAS', 'PETISCO', 7.9],
  ['AREIA SANITÁRIA GRANULADO 4KG', 'PIPICAT', 'HIGIENE', 24.9], ['AREIA SÍLICA GATOS 1,6KG', 'PIPICAT', 'HIGIENE', 34.9],
  ['TAPETE HIGIÊNICO 30UN', 'PET LIFE', 'HIGIENE', 49.9], ['SHAMPOO NEUTRO PET 500ML', 'SANOL', 'HIGIENE', 27.9],
  ['ANTIPULGAS CÃES 10-20KG', 'NEXGARD', 'FARMÁCIA', 129.9], ['VERMÍFUGO CÃES 4 COMPRIMIDOS', 'DRONTAL', 'FARMÁCIA', 59.9],
  ['SUPLEMENTO VITAMÍNICO PET 60 COMP', 'VETNIL', 'FARMÁCIA', 69.9], ['COLÍRIO PET 10ML', 'VETNIL', 'FARMÁCIA', 32.9],
  ['SACHÊ GATOS ADULTOS FRANGO 70G', 'GOLDEN', 'RAÇÃO', 3.9], ['RAÇÃO SECA PERFORMANCE CÃES 20KG', 'PREMIER', 'RAÇÃO', 249.9],
  ['PETISCO PALITOS DENTAL GATOS 80G', 'PET FLEX', 'PETISCO', 14.9], ['SHAMPOO ANTIPULGAS CÃES 500ML', 'SANOL', 'HIGIENE', 31.9],
  ['RAÇÃO SECA COELHOS 1KG', 'ZOOTEKNOS', 'RAÇÃO', 22.9], ['RAÇÃO SECA PEIXES TROPICAIS 100G', 'ALCON', 'RAÇÃO', 18.9],
  ['PETISCO BISCOITO CÃES FRUTAS 400G', 'ORIGENS', 'PETISCO', 18.9], ['AREIA SANITÁRIA PERFUMADA 12KG', 'PIPICAT', 'HIGIENE', 59.9],
];

async function semear(db) {
  const r = rng();
  const hoje = U.hojeISO();
  const dia = n => U.hojeISO(new Date(Date.now() + n * 864e5));
  const lotes = [];
  let k = 0;
  for (const [nome, marca, categoria, preco] of PRODUTOS) {
    const ean = ean13('789' + String(100000000 + k * 7919).slice(0, 9));
    k++;
    // alguns sem preço, para mostrar o modo "Só preço"
    await S.upsertProduto(db, { ean, nome, marca, categoria, preco: k % 9 === 0 ? '' : preco });
    const n = 1 + Math.floor(r() * 2);
    for (let i = 0; i < n; i++) {
      const g = 1 + Math.floor(r() * 18), lados = g === 9 || g === 10 ? ['A', 'B', 'PE', 'PD'] : ['A', 'B', 'F', 'C'], lado = lados[Math.floor(r() * 4)];
      const endereco = ['F', 'C', 'PE', 'PD'].includes(lado) ? `${g}-${lado}` : `${g}-${lado}-${1 + Math.floor(r() * 5)}`;
      const dias = Math.floor(Math.pow(r(), 1.3) * 420) - 25;        // alguns vencidos, a maioria longe
      const res = await S.leitura(db, { tipo: 'RECEBIMENTO', ean, lote: String(1000 + Math.floor(r() * 8999)), validade: dia(dias), endereco, qtd: 1 + Math.floor(r() * 24), operador: 'DEMO' });
      lotes.push(res.lote);
    }
  }
  // uma ronda feita (confere e corrige), para o painel e as metas não ficarem vazios
  for (const l of lotes.slice(0, 8)) await S.leitura(db, { tipo: 'CONTAGEM', lote_id: l.id, qtd: l.qtd, motivo: 'Ronda: confere', operador: 'DEMO' });
  await S.leitura(db, { tipo: 'CONTAGEM', lote_id: lotes[8].id, qtd: Math.max(0, lotes[8].qtd - 2), motivo: 'Ronda: corrigido', operador: 'DEMO' });
  // duas baixas por RMA com causa
  const vencidos = (await S.lotesAtivos(db)).filter(l => l.dias <= 0);
  for (const [i, causa] of ['Giro baixo', 'Comprei demais'].entries()) {
    const l = vencidos[i]; if (!l) break;
    await S.leitura(db, { tipo: 'BAIXA', lote_id: l.id, qtd: l.qtd, motivo: 'RMA', causa, operador: 'DEMO' });
  }
  return { produtos: PRODUTOS.length, lotes: lotes.length };
}

// carrega uma única vez, só se o banco estiver vazio (não mistura demonstração com estoque real)
async function semearUmaVez(db) {
  if (await db.get("SELECT 1 AS x FROM config WHERE chave='demo_carregada'")) return { pulado: true };
  const tem = await db.get('SELECT COUNT(*) AS n FROM lotes');
  if (Number(tem.n)) return { pulado: true };
  const r = await semear(db);
  await db.run("INSERT INTO config(chave,valor) VALUES('demo_carregada', ?) ON CONFLICT(chave) DO NOTHING", [JSON.stringify({ em: U.agoraISO(), ...r })]);
  return r;
}

module.exports = { semear, semearUmaVez, ean13 };
