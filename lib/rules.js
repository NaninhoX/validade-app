// Regra de prevenção vigente (editável em Configurações → Regras de desconto):
//   até 90 dias: ração (seca e úmida) 20% · resto do mix 30%
//   até 30 dias: tudo 50%
// Não existe mais a faixa de 10%.
// A perda potencial é o quanto se deixa de faturar ao vender com esse desconto (vencido = 100%).
const FAIXAS_PADRAO = [
  { ate: 0, status: 'Vencido', desconto: 0, desconto_racao: 0, peso: 10, cor: '#9f1239' },
  { ate: 15, status: 'Urgente', desconto: 50, desconto_racao: 50, peso: 6, cor: '#e11d48' },
  { ate: 30, status: 'Alerta 30d', desconto: 50, desconto_racao: 50, peso: 4, cor: '#f97316' },
  { ate: 60, status: 'Alerta 60d', desconto: 30, desconto_racao: 20, peso: 2, cor: '#eab308' },
  { ate: 90, status: 'Alerta 90d', desconto: 30, desconto_racao: 20, peso: 1, cor: '#3b82f6' },
  { ate: 120, status: 'Atenção', desconto: 0, desconto_racao: 0, peso: 0, cor: '#06b6d4' },
  { ate: null, status: 'OK', desconto: 0, desconto_racao: 0, peso: 0, cor: '#22c55e' },
];

const semAcento = s => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase();

// Ração (seca ou úmida): pela categoria cadastrada ou, na falta dela, pelo nome.
function ehRacao(nome, categoria) {
  if (categoria && semAcento(categoria).startsWith('RACAO')) return true;
  if (categoria) return false;
  return /(^|[\s)])RACAO\b/.test(semAcento(nome));
}

function classificar(dias, faixas = FAIXAS_PADRAO) {
  for (const f of faixas) if (f.ate === null || dias <= f.ate) return f;
  return faixas[faixas.length - 1];
}

function descontoPct(faixa, racao) {
  if (faixa.status === 'Vencido' || faixa.ate === 0) return 0;
  return racao ? (faixa.desconto_racao ?? faixa.desconto) : faixa.desconto;
}

function estrategia(faixa, pct) {
  if (faixa.ate === 0) return 'Retirar da loja';
  if (pct > 0) return `Oferta ${pct}%`;
  if (faixa.peso === 0 && faixa.ate !== null) return 'Acompanhar';
  return 'Venda normal';
}

module.exports = { FAIXAS_PADRAO, ehRacao, classificar, descontoPct, estrategia };
