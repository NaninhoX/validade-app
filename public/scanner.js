'use strict';
// Leitura de código de barras pela câmera do celular/Chrome.
// Usa o BarcodeDetector nativo (Chrome/Android) e cai para o ZXing quando não existe (ex.: Chrome no Windows).
// Para EAN só aceita leituras com dígito verificador correto, para não gravar produto errado.
const Scanner = (() => {
  function gtinValido(s) {
    if (!/^\d+$/.test(s) || ![8, 12, 13, 14].includes(s.length)) return false;
    const d = s.split('').map(Number), chk = d.pop();
    let soma = 0;
    d.reverse().forEach((x, i) => { soma += x * (i % 2 === 0 ? 3 : 1); });
    return (10 - (soma % 10)) % 10 === chk;
  }

  // DV da chave da NF-e (módulo 11, pesos 2 a 9 da direita para a esquerda)
  function chaveValida(c) {
    let soma = 0, peso = 2;
    for (let i = 42; i >= 0; i--) { soma += +c[i] * peso; peso = peso === 9 ? 2 : peso + 1; }
    const r = soma % 11;
    return (r < 2 ? 0 : 11 - r) === +c[43];
  }

  let zxingPronto = null;
  function carregaZxing() {
    if (window.ZXing) return Promise.resolve();
    zxingPronto = zxingPronto || new Promise((ok, erro) => {
      const s = document.createElement('script');
      s.src = '/vendor/zxing.min.js';
      s.onload = ok; s.onerror = () => erro(new Error('Não consegui carregar o leitor de código de barras'));
      document.head.appendChild(s);
    });
    return zxingPronto;
  }

  function beep(ok = true) {
    try {
      const ac = new (window.AudioContext || window.webkitAudioContext)(), o = ac.createOscillator(), g = ac.createGain();
      o.frequency.value = ok ? 1040 : 240; o.connect(g); g.connect(ac.destination); g.gain.value = 0.1; o.start(); o.stop(ac.currentTime + (ok ? 0.1 : 0.3));
    } catch { /* sem áudio */ }
    if (navigator.vibrate) navigator.vibrate(ok ? 60 : 200);
  }

  // aceitar: 'ean' (só GTIN válido) | 'chave' (chave de acesso da NF-e: 44 números com dígito verificador) | 'texto' (qualquer código, ex.: etiqueta de endereço)
  // continuo: { montar(ctl), aoLer(valor, ctl) }  mantém a câmera aberta e chama aoLer a cada código novo (um código só conta de novo depois de sair do quadro)
  async function abrir({ titulo = 'Aponte para o código de barras', aceitar = 'ean', continuo = null } = {}) {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia)
      throw new Error('A câmera só funciona em página segura (https). Use o endereço da Vercel ou digite o código.');

    const ov = document.createElement('div');
    ov.className = 'scan-ov' + (continuo ? ' continuo' : '');
    ov.innerHTML = `<video playsinline muted></video><div class="scan-top"><b>${esc(titulo)}</b><button class="icon" id="scX" aria-label="Fechar">${ico('x')}</button></div>
      <div class="scan-frame"><i></i><i></i><i></i><i></i><span class="scan-line"></span></div>
      <div class="scan-bot"><span id="scMsg" class="small">Iniciando câmera…</span><button id="scTorch" hidden>${ico('flash')} Lanterna</button></div>`;
    document.body.appendChild(ov);
    document.body.style.overflow = 'hidden';
    const video = $('video', ov), msg = $('#scMsg', ov);

    return new Promise(async (resolve, reject) => {
      let parou = false, stream = null, reader = null, raf = 0, pausado = false, ultimoVal = null, saiu = true, aceitoEm = 0;
      const limpa = () => {
        if (parou) return false;
        parou = true;
        cancelAnimationFrame(raf);
        try { reader && reader.reset(); } catch { /* ok */ }
        (stream || video.srcObject)?.getTracks?.().forEach(t => t.stop());
        ov.classList.add('out');
        setTimeout(() => { ov.remove(); document.body.style.overflow = ''; }, 220);
        return true;
      };
      const fim = valor => { if (limpa()) resolve(valor); };
      const falha = err => { document.removeEventListener('keydown', tecla); if (limpa()) reject(err); };
      const ctl = { ov, pausa: () => { pausado = true; }, retoma: () => { pausado = false; }, fecha: () => fim(null), beep, ativo: () => !parou };
      $('#scX', ov).onclick = () => fim(null);
      const tecla = e => { if (e.key === 'Escape') { document.removeEventListener('keydown', tecla); fim(null); } };
      document.addEventListener('keydown', tecla);

      const aceita = texto => {
        const t = String(texto || '').trim();
        if (!t) return false;
        if (aceitar === 'chave') {
          const dig = t.replace(/\D/g, '');
          return dig.length === 44 && chaveValida(dig) ? dig : false;
        }
        if (aceitar === 'ean') {
          const dig = t.replace(/\D/g, '');
          if (dig !== t || !gtinValido(dig)) return false;
          return dig;
        }
        return t;
      };
      const naoVi = () => { saiu = true; };
      const achou = bruto => {
        const v = aceita(bruto);
        if (!v) return;
        if (continuo) {
          if (pausado) return;
          const agora = Date.now();
          if (v === ultimoVal && (!saiu || agora - aceitoEm < 700)) return;        // o mesmo código parado na frente da câmera não soma de novo
          ultimoVal = v; saiu = false; aceitoEm = agora;
          try { continuo.aoLer(v, ctl); } catch (e) { toast(e.message, 'bad', 4000); }
          return;
        }
        beep(); msg.textContent = '✓ ' + v;
        document.removeEventListener('keydown', tecla);
        setTimeout(() => fim(v), 120);
      };

      if (continuo && continuo.montar) continuo.montar(ctl);
      try {
        const restricoes = { video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false };
        if ('BarcodeDetector' in window) {
          stream = await navigator.mediaDevices.getUserMedia(restricoes);
          video.srcObject = stream; await video.play();
          const suportados = await BarcodeDetector.getSupportedFormats();
          const quer = aceitar === 'ean' ? ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'itf'] : ['ean_13', 'ean_8', 'upc_a', 'code_128', 'code_39', 'qr_code', 'itf'];
          const det = new BarcodeDetector({ formats: quer.filter(f => suportados.includes(f)) });
          msg.textContent = 'Centralize o código dentro da moldura';
          let ultimo = 0;
          const laco = async t => {
            if (parou) return;
            if (t - ultimo > 110 && video.readyState >= 2) {
              ultimo = t;
              try { const r = await det.detect(video); if (r.length) achou(r[0].rawValue); else naoVi(); } catch { /* frame ruim */ }
            }
            raf = requestAnimationFrame(laco);
          };
          raf = requestAnimationFrame(laco);
        } else {
          await carregaZxing();
          const Z = window.ZXing;
          const hints = new Map();
          hints.set(Z.DecodeHintType.POSSIBLE_FORMATS, aceitar === 'ean'
            ? [Z.BarcodeFormat.EAN_13, Z.BarcodeFormat.EAN_8, Z.BarcodeFormat.UPC_A, Z.BarcodeFormat.UPC_E, Z.BarcodeFormat.ITF]
            : [Z.BarcodeFormat.EAN_13, Z.BarcodeFormat.EAN_8, Z.BarcodeFormat.UPC_A, Z.BarcodeFormat.CODE_128, Z.BarcodeFormat.CODE_39, Z.BarcodeFormat.QR_CODE, Z.BarcodeFormat.ITF]);
          hints.set(Z.DecodeHintType.TRY_HARDER, true);
          reader = new Z.BrowserMultiFormatReader(hints, 150);
          msg.textContent = 'Centralize o código dentro da moldura';
          reader.decodeFromConstraints(restricoes, video, (res) => { if (parou) return; if (res) achou(res.getText()); else naoVi(); }).catch(e => falha(e));
          // aguarda o stream do ZXing para habilitar a lanterna
          for (let i = 0; i < 30 && !video.srcObject; i++) await new Promise(r => setTimeout(r, 100));
          stream = video.srcObject;
        }
        // lanterna, quando o aparelho permite
        const trilha = (stream || video.srcObject)?.getVideoTracks?.()[0];
        const cap = trilha?.getCapabilities?.() || {};
        try { if (cap.focusMode?.includes?.('continuous')) await trilha.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }); } catch { /* sem foco contínuo */ }
        if (cap.torch) {
          const b = $('#scTorch', ov); b.hidden = false;
          let on = false;
          b.onclick = async () => { on = !on; try { await trilha.applyConstraints({ advanced: [{ torch: on }] }); b.classList.toggle('primary', on); } catch { /* ignorado */ } };
        }
      } catch (e) {
        falha(new Error(e.name === 'NotAllowedError' ? 'Permita o acesso à câmera nas configurações do navegador.' : e.name === 'NotFoundError' ? 'Nenhuma câmera encontrada neste aparelho.' : (e.message || 'Não consegui abrir a câmera.')));
      }
    });
  }

  return { abrir, gtinValido, chaveValida };
})();
