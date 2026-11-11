'use strict';
// Mapa da loja em 3D de verdade (WebGL, sem biblioteca): cada módulo de cada lado é um bloco com a sua cor.
// Dois modos de câmera: ÓRBITA (como num CAD: girar, mover, aproximar no ponteiro, vistas prontas) e ANDAR (dentro da loja, na altura dos olhos).
// Coordenadas: a planta usa x para a direita e y para baixo; aqui o chão é o plano XZ (z = y da planta) e Y é a altura.
const Mapa3D = (() => {
  let S = null;

  // ---------- matemática ----------
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
  const mul = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const norm = a => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
  const lim = (v, a, b) => Math.max(a, Math.min(b, v));
  const mix = (a, b, t) => a + (b - a) * t;
  const PADRAO = { sens: 1, invY: false, vel: 1, fov: 75, olhos: 170, gondola: 220 };
  const le = () => { try { return { ...PADRAO, ...(JSON.parse(localStorage.getItem('passeio3d') || '{}')) }; } catch { return { ...PADRAO }; } };
  let CFG = le();
  const guarda = () => { try { localStorage.setItem('passeio3d', JSON.stringify(CFG)); } catch { /* modo privado */ } };
  const fov = () => (S && S.modo === 'andar' && !S.tw ? CFG.fov : 50) * Math.PI / 180;

  function perspectiva(aspecto, perto, longe) {
    const f = 1 / Math.tan(fov() / 2), nf = 1 / (perto - longe);
    return [f / aspecto, 0, 0, 0, 0, f, 0, 0, 0, 0, (longe + perto) * nf, -1, 0, 0, 2 * longe * perto * nf, 0];
  }
  // matriz de visão a partir do olho e da direção (base: direita, cima, frente)
  function visao(olho, dir) {
    const f = norm(dir), r = norm(cross(f, [0, 1, 0])), u = cross(r, f);
    return { m: [r[0], u[0], -f[0], 0, r[1], u[1], -f[1], 0, r[2], u[2], -f[2], 0, -dot(r, olho), -dot(u, olho), dot(f, olho), 1], f, r, u };
  }
  function mult(a, b) {          // a · b (colunas)
    const o = new Array(16);
    for (let c = 0; c < 4; c++) for (let l = 0; l < 4; l++) o[c * 4 + l] = a[l] * b[c * 4] + a[4 + l] * b[c * 4 + 1] + a[8 + l] * b[c * 4 + 2] + a[12 + l] * b[c * 4 + 3];
    return o;
  }
  const dirDe = (Y, P) => [Math.sin(Y) * Math.cos(P), Math.sin(P), -Math.cos(Y) * Math.cos(P)];

  // ---------- cores ----------
  function corCss(txt, padrao) {
    const m = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/.exec(txt || '');
    if (m) return [m[1] / 255, m[2] / 255, m[3] / 255];
    const h = /^#([0-9a-f]{6})$/i.exec((txt || '').trim());
    if (h) return [1, 3, 5].map(i => parseInt(h[1].slice(i - 1, i + 1), 16) / 255);
    return padrao;
  }
  function tema() {
    const cs = getComputedStyle(document.documentElement), v = n => cs.getPropertyValue(n).trim();
    const sonda = document.createElement('span'); sonda.style.cssText = 'position:absolute;visibility:hidden'; document.body.appendChild(sonda);
    const le = (nome, padrao) => { sonda.style.color = ''; sonda.style.color = v(nome) || 'transparent'; const c = corCss(getComputedStyle(sonda).color, null); return c || padrao; };
    const t = { fundo: le('--surface', [.12, .12, .13]), linha: le('--line-2', [.3, .3, .32]), vazio: le('--heat-empty', [.24, .24, .26]), realce: le('--accent', [.2, .5, 1]), tinta: le('--ink', [1, 1, 1]) };
    sonda.remove();
    t.escuro = t.fundo[0] + t.fundo[1] + t.fundo[2] < 1.5;
    return t;
  }

  // ---------- WebGL ----------
  const VS = 'attribute vec3 p;attribute vec3 n;attribute vec3 c;uniform mat4 m;uniform vec3 luz;varying vec3 vc;varying float vd;void main(){float l=n==vec3(0.)?1.:.5+.5*max(dot(n,luz),0.)+.12*n.y;vc=c*l;gl_Position=m*vec4(p,1.);vd=gl_Position.w;}';
  const FS = 'precision mediump float;varying vec3 vc;varying float vd;uniform vec3 fundo;uniform float nevoa;void main(){float f=clamp(vd/nevoa,0.,1.);gl_FragColor=vec4(mix(vc,fundo,f*f*.85),1.);}';
  function programa(gl) {
    const sh = (tipo, src) => { const s = gl.createShader(tipo); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)); return s; };
    const p = gl.createProgram(); gl.attachShader(p, sh(gl.VERTEX_SHADER, VS)); gl.attachShader(p, sh(gl.FRAGMENT_SHADER, FS)); gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    return { p, a: { p: gl.getAttribLocation(p, 'p'), n: gl.getAttribLocation(p, 'n'), c: gl.getAttribLocation(p, 'c') }, u: { m: gl.getUniformLocation(p, 'm'), luz: gl.getUniformLocation(p, 'luz'), fundo: gl.getUniformLocation(p, 'fundo'), nevoa: gl.getUniformLocation(p, 'nevoa') } };
  }

  // triângulos das caixas e do chão; linhas da grade, do contorno e da seleção
  function geometria() {
    const sc = S.cena, t = S.tema, T = [], Ln = [];
    const quad = (a, b, c, d, n, cor) => { for (const v of [a, b, c, a, c, d]) T.push(v[0], v[1], v[2], n[0], n[1], n[2], cor[0], cor[1], cor[2]); };
    const linha = (a, b, cor) => { Ln.push(a[0], a[1], a[2], 0, 0, 0, cor[0], cor[1], cor[2], b[0], b[1], b[2], 0, 0, 0, cor[0], cor[1], cor[2]); };
    const W = sc.largura, H = sc.altura, m = Math.max(W, H);
    const chao = t.escuro ? t.fundo.map(v => v * 1.25 + .012) : t.fundo.map(v => v * .97);
    quad([-m, -.02, -m], [-m, -.02, H + m], [W + m, -.02, H + m], [W + m, -.02, -m], [0, 1, 0], t.fundo.map(v => v * (t.escuro ? .8 : .93)));
    quad([0, -.01, 0], [0, -.01, H], [W, -.01, H], [W, -.01, 0], [0, 1, 0], chao);
    const passo = 100 * sc.e, cg = chao.map((v, i) => mix(v, t.linha[i], .5));
    for (let x = passo; x < W; x += passo) linha([x, 0, 0], [x, 0, H], cg);
    for (let z = passo; z < H; z += passo) linha([0, 0, z], [W, 0, z], cg);
    for (const [a, b] of [[[0, 0, 0], [W, 0, 0]], [[W, 0, 0], [W, 0, H]], [[W, 0, H], [0, 0, H]], [[0, 0, H], [0, 0, 0]]]) linha(a, b, t.realce);
    for (const b of sc.caixas) {
      const semLote = chao.map((v, i) => mix(v, t.tinta[i], t.escuro ? .2 : .14));       // módulo vazio: cinza que ainda se destaca do chão
      let cor = b.cor ? corCss(b.cor, semLote) : semLote;
      if (b === S.sobre) cor = cor.map(v => Math.min(1, v * 1.18 + .05));
      const x0 = b.x, x1 = b.x + b.w, z0 = b.y, z1 = b.y + b.h, y1 = b.z;
      quad([x0, y1, z0], [x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [0, 1, 0], cor);
      quad([x0, 0, z1], [x1, 0, z1], [x1, y1, z1], [x0, y1, z1], [0, 0, 1], cor);
      quad([x1, 0, z0], [x0, 0, z0], [x0, y1, z0], [x1, y1, z0], [0, 0, -1], cor);
      quad([x1, 0, z1], [x1, 0, z0], [x1, y1, z0], [x1, y1, z1], [1, 0, 0], cor);
      quad([x0, 0, z0], [x0, 0, z1], [x0, y1, z1], [x0, y1, z0], [-1, 0, 0], cor);
      const borda = b.sel ? t.realce : cor.map(v => v * .55);
      const P = [[x0, z0], [x1, z0], [x1, z1], [x0, z1]];
      for (let i = 0; i < 4; i++) {
        const a = P[i], c = P[(i + 1) % 4];
        linha([a[0], y1 + .02, a[1]], [c[0], y1 + .02, c[1]], borda);
        if (b.sel) { linha([a[0], .02, a[1]], [c[0], .02, c[1]], borda); linha([a[0], 0, a[1]], [a[0], y1, a[1]], borda); }
      }
    }
    if (sc.rota && sc.rota.length) {
      const larg = 16 * sc.e, pts = [[sc.largura * .5, 0].concat([])];
      const R = sc.rota;
      const fita = (a, b) => {
        const dx = b.x - a.x, dz = b.z - a.z, L = Math.hypot(dx, dz) || 1, nx = -dz / L * larg / 2, nz = dx / L * larg / 2, y = .35;
        quad([a.x + nx, y, a.z + nz], [b.x + nx, y, b.z + nz], [b.x - nx, y, b.z - nz], [a.x - nx, y, a.z - nz], [0, 1, 0], t.realce);
        quad([a.x - nx, y, a.z - nz], [b.x - nx, y, b.z - nz], [b.x + nx, y, b.z + nz], [a.x + nx, y, a.z + nz], [0, -1, 0], t.realce);
      };
      for (let i = 0; i + 1 < R.length; i++) fita(R[i], R[i + 1]);
      for (const p of R) { const h = 26 * sc.e; quad([p.x - h, .6, p.z - h], [p.x - h, .6, p.z + h], [p.x + h, .6, p.z + h], [p.x + h, .6, p.z - h], [0, 1, 0], t.realce); }
    }
    const gl = S.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, S.bufT); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(T), gl.STATIC_DRAW); S.nT = T.length / 9;
    gl.bindBuffer(gl.ARRAY_BUFFER, S.bufL); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(Ln), gl.STATIC_DRAW); S.nL = Ln.length / 9;
  }

  // ---------- câmera ----------
  // pose = olho + direção (Y = giro, P = inclinação). Na órbita a pose sai de alvo/distância/ângulos.
  function poseOrbita(o) {
    const off = [Math.sin(o.th) * Math.cos(o.ph), Math.sin(o.ph), Math.cos(o.th) * Math.cos(o.ph)];
    return { olho: add([o.tx, 0, o.tz], mul(off, o.d)), Y: -o.th + Math.PI * 0, P: -o.ph, dir: mul(off, -1) };
  }
  function poseAtual() {
    if (S.tw) {
      const k = lim((performance.now() - S.tw.t0) / S.tw.ms, 0, 1), e = k < .5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2, a = S.tw.de, b = S.tw.para;
      const p = { olho: [mix(a.olho[0], b.olho[0], e), mix(a.olho[1], b.olho[1], e), mix(a.olho[2], b.olho[2], e)] };
      p.dir = norm([mix(a.dir[0], b.dir[0], e), mix(a.dir[1], b.dir[1], e), mix(a.dir[2], b.dir[2], e)]);
      if (k >= 1) { const fim = S.tw.fim; S.tw = null; if (fim) fim(); }
      return p;
    }
    if (S.modo === 'andar') return { olho: [S.a.x, S.a.alt, S.a.z], dir: dirDe(S.a.Y, S.a.P) };
    return poseOrbita(S.o);
  }
  function vaiPara(pose, ms, fim) {
    const de = poseAtual();
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) ms = 0;
    if (!ms) { S.tw = null; if (fim) fim(); pede(); return; }
    S.tw = { de, para: pose, t0: performance.now(), ms, fim }; pede();
  }
  function orbitaPara(o, ms = 550) { const alvo = { ...S.o, ...o }; vaiPara(poseOrbita(alvo), ms, () => { S.o = alvo; }); if (!ms || matchMedia('(prefers-reduced-motion: reduce)').matches) S.o = alvo; }

  function enquadra(ms = 600, vista) {
    const sc = S.cena, w = S.cv.clientWidth || 800, h = S.cv.clientHeight || 500;
    const o = { tx: sc.largura / 2, tz: sc.altura / 2, th: S.o ? S.o.th : -.55, ph: S.o ? S.o.ph : .78 };
    if (vista === 'topo') { o.th = 0; o.ph = 1.553; }
    if (vista === 'frente') { o.th = 0; o.ph = .2; }
    if (vista === 'iso') { o.th = -.6; o.ph = .72; }
    // distância para caber: o maior lado da planta projetado, com folga
    const raio = Math.hypot(sc.largura, sc.altura) / 2, asp = w / h;
    o.d = raio / Math.tan(fov() / 2) / Math.min(1, asp) * (o.ph > 1.4 ? .82 : .92);
    orbitaPara(o, ms);
  }

  // matriz CSS que cola um retângulo W×H (pixels) num quadrilátero da tela (TL, TR, BR, BL)
  function matrizFace(W, H, p) {
    const [x0, y0] = p[0], [x1, y1] = p[1], [x2, y2] = p[2], [x3, y3] = p[3];
    const sx = x0 - x1 + x2 - x3, sy = y0 - y1 + y2 - y3;
    let a, b, c, d, g = 0, h = 0;
    if (Math.abs(sx) < 1e-6 && Math.abs(sy) < 1e-6) { a = x1 - x0; b = y1 - y0; c = x3 - x0; d = y3 - y0; }
    else {
      const dx1 = x1 - x2, dx2 = x3 - x2, dy1 = y1 - y2, dy2 = y3 - y2, den = dx1 * dy2 - dx2 * dy1;
      if (Math.abs(den) < 1e-9) return null;
      g = (sx * dy2 - dx2 * sy) / den; h = (dx1 * sy - sx * dy1) / den;
      a = x1 - x0 + g * x1; b = y1 - y0 + g * y1; c = x3 - x0 + h * x3; d = y3 - y0 + h * y3;
    }
    return `matrix3d(${a / W},${b / W},0,${g / W},${c / H},${d / H},0,${h / H},0,0,1,0,${x0},${y0},0,1)`;
  }
  // a primeira caixa que o raio atravessa antes de "ate" (distância); null se o caminho está livre
  function bloqueio(o, dir, ate, exceto) {
    for (const b of S.cena.caixas) {
      if (b === exceto) continue;
      const mn = [b.x, 0, b.y], mx = [b.x + b.w, b.z, b.y + b.h];
      let t0 = 0, t1 = Infinity, ok = true;
      for (let i = 0; i < 3 && ok; i++) {
        if (Math.abs(dir[i]) < 1e-9) { if (o[i] < mn[i] || o[i] > mx[i]) ok = false; continue; }
        let u = (mn[i] - o[i]) / dir[i], v = (mx[i] - o[i]) / dir[i]; if (u > v) [u, v] = [v, u];
        t0 = Math.max(t0, u); t1 = Math.min(t1, v); if (t0 > t1) ok = false;
      }
      if (ok && t0 < ate - 1) return b;
    }
    return null;
  }

  // raio do ponteiro → caixa mais próxima, ou ponto no chão
  function raio(cx, cy) {
    const r = S.cv.getBoundingClientRect(), nx = ((cx - r.left) / r.width) * 2 - 1, ny = 1 - ((cy - r.top) / r.height) * 2, t = Math.tan(fov() / 2), asp = r.width / r.height;
    const V = S.v;
    return { o: S.pose.olho, d: norm(add(add(V.f, mul(V.r, nx * t * asp)), mul(V.u, ny * t))) };
  }
  function acerta(cx, cy) {
    const R = raio(cx, cy);
    let melhor = null, tMin = Infinity;
    for (const b of S.cena.caixas) {
      const mn = [b.x, 0, b.y], mx = [b.x + b.w, b.z, b.y + b.h];
      let t0 = 0, t1 = Infinity, ok = true;
      for (let i = 0; i < 3 && ok; i++) {
        if (Math.abs(R.d[i]) < 1e-9) { if (R.o[i] < mn[i] || R.o[i] > mx[i]) ok = false; continue; }
        let a = (mn[i] - R.o[i]) / R.d[i], c = (mx[i] - R.o[i]) / R.d[i]; if (a > c) [a, c] = [c, a];
        t0 = Math.max(t0, a); t1 = Math.min(t1, c); if (t0 > t1) ok = false;
      }
      if (ok && t0 < tMin) { tMin = t0; melhor = b; }
    }
    let chao = null;
    if (R.d[1] < -1e-6) { const t = -R.o[1] / R.d[1]; if (t < tMin) chao = [R.o[0] + R.d[0] * t, R.o[2] + R.d[2] * t]; }
    return { caixa: chao ? null : melhor, chao };
  }

  // ---------- andar ----------
  const RAIO_CORPO = 28;                                        // cm
  function livre(x, z) {
    const sc = S.cena, r = RAIO_CORPO * sc.e;
    if (x < r || z < r || x > sc.largura - r || z > sc.altura - r) return false;
    for (const b of sc.caixas) if (b.z > 25 * sc.e && x > b.x - r && x < b.x + b.w + r && z > b.y - r && z < b.y + b.h + r) return false;
    return true;
  }
  function anda(dx, dz) {
    const a = S.a;
    if (livre(a.x + dx, a.z)) a.x += dx;
    if (livre(a.x, a.z + dz)) a.z += dz;
  }
  function entraAndar(ponto) {
    const sc = S.cena;
    let x = ponto ? ponto[0] : S.o.tx, z = ponto ? ponto[1] : S.o.tz;
    x = lim(x, 40 * sc.e, sc.largura - 40 * sc.e); z = lim(z, 40 * sc.e, sc.altura - 40 * sc.e);
    if (!livre(x, z)) {                                        // procura o ponto livre mais perto, em espiral
      let achou = false;
      for (let raioB = 20 * sc.e; raioB < Math.max(sc.largura, sc.altura) && !achou; raioB += 20 * sc.e) for (let k = 0; k < 16 && !achou; k++) { const xx = x + Math.cos(k / 16 * 6.283) * raioB, zz = z + Math.sin(k / 16 * 6.283) * raioB; if (livre(xx, zz)) { x = xx; z = zz; achou = true; } }
    }
    const a = { x, z, alt: CFG.olhos * sc.e, Y: -S.o.th, P: 0, vx: 0, vz: 0 };
    vaiPara({ olho: [a.x, a.alt, a.z], dir: dirDe(a.Y, a.P) }, 900, () => { S.a = a; S.modo = 'andar'; S.destino = null; interface_(); });
    S.aPend = a;
  }
  function saiAndar() {
    const a = S.a; if (!a) return;
    const o = { ...S.o, tx: a.x, tz: a.z, th: -a.Y };
    if (document.pointerLockElement === S.cv) document.exitPointerLock();
    S.modo = 'orbita'; S.destino = null; S.o = o; interface_();
    S.tw = { de: { olho: [a.x, a.alt, a.z], dir: dirDe(a.Y, a.P) }, para: poseOrbita(o), t0: performance.now(), ms: 800, fim: null }; pede();
  }

  // ---------- desenho ----------
  function pede() { if (S && !S.raf) S.raf = requestAnimationFrame(quadro); }
  function quadro(agora) {
    if (!S) return;
    S.raf = 0;
    if (!S.cv.isConnected) { destroi(); return; }
    const dt = Math.min(.05, (agora - (S.tAnt || agora)) / 1000); S.tAnt = agora;
    let segue = false;
    // teclado e destino (andar) / teclado (órbita)
    const K = S.teclas, sc = S.cena;
    if (S.modo === 'andar' && !S.tw) {
      const a = S.a, vMax = 150 * CFG.vel * sc.e * (K.has('shift') ? 1.9 : 1), vel = vMax * dt;
      let fr = (K.has('w') || K.has('arrowup') ? 1 : 0) - (K.has('s') || K.has('arrowdown') ? 1 : 0), la = (K.has('d') ? 1 : 0) - (K.has('a') ? 1 : 0);
      if (S.manche) { fr += -S.manche.y; la += S.manche.x; }
      const mag = Math.hypot(fr, la); if (mag > 1) { fr /= mag; la /= mag; }
      const gira = (K.has('arrowright') ? 1 : 0) - (K.has('arrowleft') ? 1 : 0);
      if (gira) { a.Y += gira * 1.7 * dt; segue = true; }
      const ax = (Math.sin(a.Y) * fr + Math.cos(a.Y) * la) * vMax, az = (-Math.cos(a.Y) * fr + Math.sin(a.Y) * la) * vMax, sua = Math.min(1, dt * 11);
      a.vx = (a.vx || 0) + (ax - (a.vx || 0)) * sua; a.vz = (a.vz || 0) + (az - (a.vz || 0)) * sua;       // acelera e freia suave
      if (mag > .01) S.destino = null;
      if (Math.hypot(a.vx, a.vz) > vMax * .02 + .001) { anda(a.vx * dt, a.vz * dt); segue = true; } else { a.vx = 0; a.vz = 0; }
      if (S.destino) {
        const dx = S.destino[0] - a.x, dz = S.destino[1] - a.z, dist = Math.hypot(dx, dz), p = Math.min(dist, vel * 1.25), x0 = a.x, z0 = a.z;
        if (dist < 4 * sc.e) S.destino = null; else { anda(dx / dist * p, dz / dist * p); if (Math.hypot(a.x - x0, a.z - z0) < p * .2) S.destino = null; else segue = true; }
      }
    } else if (S.modo === 'orbita' && !S.tw && K.size) {
      const o = S.o, v = o.d * .9 * dt;
      const fr = (K.has('arrowup') || K.has('w') ? 1 : 0) - (K.has('arrowdown') || K.has('s') ? 1 : 0), la = (K.has('arrowright') || K.has('d') ? 1 : 0) - (K.has('arrowleft') || K.has('a') ? 1 : 0);
      const gira = (K.has('e') ? 1 : 0) - (K.has('q') ? 1 : 0);
      if (fr || la) { o.tx += (-Math.sin(o.th) * fr + Math.cos(o.th) * la) * v; o.tz += (-Math.cos(o.th) * fr - Math.sin(o.th) * la) * v; segue = true; }
      if (gira) { o.th += gira * 1.6 * dt; segue = true; }
    }
    const gl = S.gl, cv = S.cv, dpr = Math.min(2, window.devicePixelRatio || 1), w = Math.max(1, Math.round(cv.clientWidth * dpr)), h = Math.max(1, Math.round(cv.clientHeight * dpr));
    if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
    gl.viewport(0, 0, w, h);
    const pose = poseAtual(); S.pose = pose;
    const V = visao(pose.olho, pose.dir); S.v = V;
    const longe = Math.hypot(sc.largura, sc.altura) * 6, perto = Math.max(2 * sc.e, longe / 4000);
    S.mvp = mult(perspectiva(w / h, perto, longe), V.m);
    const f = S.tema.fundo;
    gl.clearColor(f[0], f[1], f[2], 1); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.useProgram(S.prog.p);
    gl.uniformMatrix4fv(S.prog.u.m, false, new Float32Array(S.mvp));
    gl.uniform3fv(S.prog.u.luz, norm([.45, .8, .35])); gl.uniform3fv(S.prog.u.fundo, f); gl.uniform1f(S.prog.u.nevoa, longe * (S.modo === 'andar' ? .22 : .9));
    const liga = buf => { gl.bindBuffer(gl.ARRAY_BUFFER, buf); const a = S.prog.a; gl.enableVertexAttribArray(a.p); gl.vertexAttribPointer(a.p, 3, gl.FLOAT, false, 36, 0); gl.enableVertexAttribArray(a.n); gl.vertexAttribPointer(a.n, 3, gl.FLOAT, false, 36, 12); gl.enableVertexAttribArray(a.c); gl.vertexAttribPointer(a.c, 3, gl.FLOAT, false, 36, 24); };
    liga(S.bufT); gl.drawArrays(gl.TRIANGLES, 0, S.nT);
    liga(S.bufL); gl.drawArrays(gl.LINES, 0, S.nL);
    rotulos();
    if (S.tw || segue) pede();
  }

  // ponto do mundo → pixel na tela (null se atrás da câmera)
  function tela(p) {
    const m = S.mvp, x = m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12], y = m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13], w = m[3] * p[0] + m[7] * p[1] + m[11] * p[2] + m[15];
    if (w <= 0.001) return null;
    return [(x / w * .5 + .5) * S.cv.clientWidth, (1 - (y / w * .5 + .5)) * S.cv.clientHeight, w];
  }

  // rótulos em HTML por cima do desenho: gôndolas (sempre) e, de perto ou andando, a frente de cada módulo
  function rotulos() {
    const sc = S.cena, W = S.cv.clientWidth, H = S.cv.clientHeight, olho = S.pose.olho, e = sc.e;
    const dentro = t => t && t[0] > -60 && t[0] < W + 60 && t[1] > -30 && t[1] < H + 30;
    sc.gondolas.forEach((g, i) => {
      const el = S.rg[i], t = tela([g.cx, g.topo + 14 * e, g.cy]);
      const dist = Math.hypot(g.cx - olho[0], g.cy - olho[2]);
      if (!dentro(t) || (S.modo === 'andar' && dist > 1500 * e)) { el.style.display = 'none'; return; }
      el.style.display = ''; el.style.transform = `translate(${t[0].toFixed(1)}px, ${t[1].toFixed(1)}px) translate(-50%, -100%)`;
      el.classList.toggle('longe', t[2] > Math.hypot(sc.largura, sc.altura) * 1.15);
    });
    (sc.rota || []).forEach((p, i) => { const el = S.rr[i], t = el && tela([p.x, 12 * e, p.z]); if (!el) return; if (!dentro(t)) { el.style.display = 'none'; return; } el.style.display = ''; el.style.transform = `translate(${t[0].toFixed(1)}px, ${t[1].toFixed(1)}px) translate(-50%, -50%)`; el.classList.toggle('longe', t[2] > Math.hypot(sc.largura, sc.altura) * 1.1); });
    // módulos: os mais próximos virados para a câmera; os de lado A/B ganham o cartão colado na própria face
    const perto = S.modo === 'andar' ? 700 * e : 600 * e, lista = [], faces = [];
    sc.caixas.forEach((b, i) => {
      const el = S.rm[i]; if (!el) return;
      if (b.face) {
        const sul = b.n[1] > 0, x0 = sul ? b.x : b.x + b.w, dx = sul ? 1 : -1, zf = sul ? b.y + b.h : b.y;
        const yT = b.z * .94, yB = b.z * .1, P = [[x0, yT], [x0 + dx * b.w, yT], [x0 + dx * b.w, yB], [x0, yB]].map(q => [q[0], q[1], zf]);
        const cx = b.x + b.w / 2, cz = zf, dist = Math.hypot(olho[0] - cx, olho[1] - b.z * .5, olho[2] - cz);
        const para = [olho[0] - cx, olho[2] - cz], face = (para[0] * b.n[0] + para[1] * b.n[1]) / (Math.hypot(para[0], para[1]) || 1);
        if (face < .12 || dist > perto * 2.2) { el.style.display = 'none'; return; }
        const pts = P.map(q => tela(q));
        if (pts.some(q => !q)) { el.style.display = 'none'; return; }
        const larg = Math.hypot(pts[1][0] - pts[0][0], pts[1][1] - pts[0][1]);
        if (larg < 90 || larg > W * 6) { el.style.display = 'none'; return; }
        faces.push({ el, b, pts, dist, centro: [cx, b.z * .5, cz], larg });
        return;
      }
      const c = [b.x + b.w / 2 + b.n[0] * b.w / 2, b.z * .56, b.y + b.h / 2 + b.n[1] * b.h / 2];
      const para = [olho[0] - c[0], olho[2] - c[2]], dist = Math.hypot(olho[0] - c[0], olho[1] - c[1], olho[2] - c[2]);
      const face = (para[0] * b.n[0] + para[1] * b.n[1]) / (Math.hypot(para[0], para[1]) || 1);
      if ((dist < perto && face > .2) || b === S.sobre) lista.push({ el, c, dist: b === S.sobre ? 0 : dist }); else el.style.display = 'none';
    });
    faces.sort((a, b) => a.dist - b.dist);
    faces.forEach((f, k) => {
      let ok = k < 16;
      if (ok) { const d = sub(f.centro, olho), L = Math.hypot(d[0], d[1], d[2]); ok = !bloqueio(olho, mul(d, 1 / L), L - 2 * e, f.b); }   // atrás de outra gôndola: não mostra
      if (!ok) { f.el.style.display = 'none'; return; }
      const hCard = Math.round(Math.max(214, Math.min(640, 280 * (f.b.z * .84) / f.b.w)));
      const m = matrizFace(280, hCard, f.pts);
      if (f.el.dataset.h !== String(hCard)) { f.el.dataset.h = String(hCard); f.el.style.height = hCard + 'px'; f.el.classList.toggle('alto', hCard > 330); }
      if (!m) { f.el.style.display = 'none'; return; }
      f.el.style.display = ''; f.el.style.transform = m; f.el.style.zIndex = String(60 - k);
      f.el.classList.toggle('sel', !!f.b.sel);
    });
    lista.sort((a, b) => a.dist - b.dist);
    lista.forEach((x, k) => {
      const t = k < 12 ? tela(x.c) : null;
      if (!dentro(t)) { x.el.style.display = 'none'; return; }
      const esc_ = lim(260 * e / x.dist * (H / 520), .55, 1.15);
      x.el.style.display = ''; x.el.style.zIndex = String(100 - k);
      x.el.style.transform = `translate(${t[0].toFixed(1)}px, ${t[1].toFixed(1)}px) translate(-50%, -50%) scale(${esc_.toFixed(2)})`;
    });
  }

  const ESC = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  function montaRotulos() {
    const sc = S.cena;
    S.cam.innerHTML = sc.gondolas.map(g => `<div class="m3-g"><b>${ESC(g.id)}</b>${g.nome ? `<span> · ${ESC(g.nome)}</span>` : ''}${g.tag ? `<i>${g.tag}</i>` : ''}${g.sub ? `<small>${ESC(g.sub)}</small>` : ''}</div>`).join('')
      + sc.caixas.map(b => (b.face ? `<div class="m3-face fr-mod${b.face.vazio ? ' vazia' : ''}" style="--hc:${ESC(b.cor || 'var(--heat-empty)')};--hi:${ESC(b.tinta || '#111')}"><div class="fr-h"><b>${ESC(b.face.num)}</b><span>${ESC(b.face.nome)}</span></div>${b.face.corpo}</div>` : b.chave && b.l1 ? `<div class="m3-m" style="--c:${ESC(b.cor || 'var(--heat-empty)')};--t:${ESC(b.tinta || '#111')}"><b>${ESC(b.curto)}</b><span>${ESC(b.l1)}</span><small>${ESC(b.l2 || '')}</small>${b.l3 ? `<small>${ESC(b.l3)}</small>` : ''}${b.l4 ? `<small class="m3-p">${ESC(b.l4)}</small>` : ''}</div>` : '<div class="m3-m" hidden></div>')).join('');
    S.cam.insertAdjacentHTML('beforeend', (sc.rota || []).map(p => `<div class="m3-rt" title="${ESC(p.end)}"><b>${p.n}</b><span>${ESC(p.end)}</span></div>`).join(''));
    S.rr = [...S.cam.querySelectorAll('.m3-rt')];
    const filhos = [...S.cam.children].filter(el => !el.classList.contains('m3-rt'));
    S.rg = filhos.slice(0, sc.gondolas.length);
    S.rm = filhos.slice(sc.gondolas.length).map(el => (el.hidden ? null : el));
  }

  function interface_() {
    const andar = S.modo === 'andar';
    S.barra.innerHTML = andar
      ? '<button data-a="sair" class="primary">Sair do passeio</button><button data-a="ajustes" title="Sensibilidade, velocidade, campo de visão e alturas">Ajustes</button><span class="m3-dica">' + (matchMedia('(pointer: coarse)').matches ? 'Manche à esquerda para andar · arraste para olhar · toque num módulo para abrir' : 'Clique na loja para controlar com o mouse · W A S D anda · Shift corre · clique abre o módulo da mira · Esc solta o mouse') + '</span>'
      : '<button data-a="topo" title="Vista de cima">Topo</button><button data-a="frente" title="Vista de frente, baixa">Frente</button><button data-a="iso" title="Vista em perspectiva">Perspectiva</button><button data-a="fit" title="Enquadrar a loja toda (F)">Enquadrar</button><button data-a="andar" class="primary" title="Entrar na loja e andar pelos corredores">Andar pela loja</button><button data-a="ajustes" title="Ajustes do passeio e altura das gôndolas">Ajustes</button><span class="m3-dica">Arraste para girar · botão direito (ou Shift) para mover · rolagem aproxima no ponteiro · duplo clique foca</span>';
    S.host.classList.toggle('andando', andar);
  }

  // ---------- controles ----------
  function liga() {
    const cv = S.cv, ptrs = new Map();
    let arr = null, moveu = false, pinca = null;
    const chaoEm = (x, y) => { const a = acertaChao(x, y); return a; };
    cv.addEventListener('contextmenu', e => e.preventDefault());
    cv.addEventListener('pointerdown', e => {
      cv.focus({ preventScroll: true });
      ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
      try { cv.setPointerCapture(e.pointerId); } catch { /* ok */ }
      moveu = false;
      if (ptrs.size === 1) arr = { x: e.clientX, y: e.clientY, mover: e.button === 2 || e.button === 1 || e.shiftKey };
      if (ptrs.size === 2) { const [a, b] = [...ptrs.values()]; pinca = { d: Math.hypot(a.x - b.x, a.y - b.y) || 1, mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2, ang: Math.atan2(b.y - a.y, b.x - a.x) }; arr = null; moveu = true; }
      e.preventDefault();
    });
    cv.addEventListener('pointermove', e => {
      if (preso()) { passa(e); return; }                         // mouse preso: olha em volta mesmo com botão apertado
      if (!ptrs.has(e.pointerId)) { if (e.pointerType === 'mouse') passa(e); return; }
      ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (S.tw) return;
      const h = cv.clientHeight || 1;
      if (ptrs.size === 2 && pinca) {
        const [a, b] = [...ptrs.values()], d = Math.hypot(a.x - b.x, a.y - b.y) || 1, mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2, ang = Math.atan2(b.y - a.y, b.x - a.x);
        if (S.modo === 'orbita') { const o = S.o; move(mx - pinca.mx, my - pinca.my); o.d = lim(o.d * pinca.d / d, S.dMin, S.dMax); let da = ang - pinca.ang; if (da > 3) da -= 6.283; if (da < -3) da += 6.283; o.th -= da; }

        pinca = { d, mx, my, ang }; pede(); return;
      }
      if (!arr) return;
      const dx = e.clientX - arr.x, dy = e.clientY - arr.y;
      if (!moveu && Math.hypot(dx, dy) < 5) return;
      moveu = true; arr.x = e.clientX; arr.y = e.clientY;
      if (S.modo === 'andar') { olha(dx * 1.6, dy * 1.6); }
      else if (arr.mover) move(dx, dy);
      else { S.o.th -= dx * .0062; S.o.ph = lim(S.o.ph + dy * .0055, .06, 1.553); }
      S.cv.style.cursor = 'grabbing'; pede();
    });
    const solta = e => {
      if (!ptrs.has(e.pointerId)) return;
      ptrs.delete(e.pointerId); if (ptrs.size < 2) pinca = null;
      S.cv.style.cursor = '';
      if (ptrs.size === 0 && !moveu && e.type === 'pointerup' && e.button === 0) clique(e);
      if (ptrs.size === 0) arr = null;
    };
    cv.addEventListener('pointerup', solta); cv.addEventListener('pointercancel', solta);
    cv.addEventListener('wheel', e => {
      e.preventDefault(); if (S.tw) return;
      if (S.modo === 'andar') return;
      const o = S.o, fator = Math.exp(e.deltaY * (e.ctrlKey ? .01 : .0014)), d1 = lim(o.d * fator, S.dMin, S.dMax), k = d1 / o.d, pt = chaoEm(e.clientX, e.clientY);
      if (pt) { o.tx = pt[0] + (o.tx - pt[0]) * k; o.tz = pt[1] + (o.tz - pt[1]) * k; }      // o ponto sob o ponteiro fica parado, como no CAD
      o.d = d1; pede();
    }, { passive: false });
    cv.addEventListener('dblclick', e => {
      if (S.modo !== 'orbita') return;
      const a = acerta(e.clientX, e.clientY);
      if (a.caixa) { const b = a.caixa, g = S.cena.gondolas.find(x => x.id === b.g); orbitaPara({ tx: g ? g.cx : b.x + b.w / 2, tz: g ? g.cy : b.y + b.h / 2, d: lim((g ? g.tam : Math.max(b.w, b.h)) * 1.5, S.dMin * 3, S.dMax) }); }
      else if (a.chao) orbitaPara({ tx: a.chao[0], tz: a.chao[1], d: lim(S.o.d * .55, S.dMin, S.dMax) });
    });
    cv.addEventListener('keydown', e => {
      const k = e.key.toLowerCase();
      if (['w', 'a', 's', 'd', 'q', 'e', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright', 'shift'].includes(k)) { S.teclas.add(k); e.preventDefault(); pede(); return; }
      if (k === 'escape' && S.modo === 'andar') { if (!S.painel.hidden) { S.painel.hidden = true; } else saiAndar(); e.preventDefault(); e.stopPropagation(); return; }
      if (S.modo !== 'orbita') return;
      if (k === 'f') enquadra(500);
      if (k === '+' || k === '=') orbitaPara({ d: lim(S.o.d / 1.4, S.dMin, S.dMax) }, 200);
      if (k === '-') orbitaPara({ d: lim(S.o.d * 1.4, S.dMin, S.dMax) }, 200);
    });
    cv.addEventListener('keyup', e => { S.teclas.delete(e.key.toLowerCase()); });
    cv.addEventListener('blur', () => S.teclas.clear());
    cv.addEventListener('pointerleave', () => { if (S.sobre) { S.sobre = null; geometria(); pede(); } });
    S.barra.addEventListener('click', e => {
      const b = e.target.closest('[data-a]'); if (!b) return;
      const a = b.dataset.a;
      if (a === 'ajustes') { S.painel.hidden = !S.painel.hidden; if (!S.painel.hidden) painelAjustes(); return; }
      if (a === 'andar') entraAndar(); else if (a === 'sair') saiAndar(); else if (a === 'fit') enquadra(550); else enquadra(650, a);
      cv.focus({ preventScroll: true });
    });
    S.aoTravar = () => { if (S) { S.host.classList.toggle('preso', preso()); S.teclas.clear(); pede(); } };
    document.addEventListener('pointerlockchange', S.aoTravar);
    // manche de toque (andar no celular)
    const mj = S.manche_el, pino = mj.firstElementChild;
    const mexe = e => { const r = mj.getBoundingClientRect(), raioM = r.width / 2; let x = (e.clientX - r.left - raioM) / raioM, y = (e.clientY - r.top - raioM) / raioM; const l = Math.hypot(x, y); if (l > 1) { x /= l; y /= l; } S.manche = { x, y }; pino.style.transform = `translate(${x * raioM * .55}px, ${y * raioM * .55}px)`; pede(); };
    mj.addEventListener('pointerdown', e => { e.preventDefault(); e.stopPropagation(); try { mj.setPointerCapture(e.pointerId); } catch { /* ok */ } mexe(e); });
    mj.addEventListener('pointermove', e => { if (S.manche) mexe(e); });
    const largaM = () => { S.manche = null; pino.style.transform = ''; };
    mj.addEventListener('pointerup', largaM); mj.addEventListener('pointercancel', largaM);
    S.ro = new ResizeObserver(() => pede()); S.ro.observe(S.host);
  }
  function olha(mx, my) {
    const k = .0021 * CFG.sens;
    S.a.Y += mx * k; S.a.P = lim(S.a.P + my * k * (CFG.invY ? 1 : -1), -1.35, 1.35);
  }
  // painel de ajustes, no jeito das opções de um jogo em primeira pessoa
  function painelAjustes() {
    const linha = (k, rot, min, max, passo, fmt) => `<label class="m3-aj"><span>${rot}</span><input type="range" data-k="${k}" min="${min}" max="${max}" step="${passo}" value="${CFG[k]}"><b data-v="${k}">${fmt(CFG[k])}</b></label>`;
    const F = { sens: v => Number(v).toFixed(1) + '×', vel: v => Number(v).toFixed(1) + '×', fov: v => v + '°', olhos: v => (v / 100).toFixed(2).replace('.', ',') + ' m', gondola: v => (v / 100).toFixed(2).replace('.', ',') + ' m' };
    S.painel.innerHTML = `<div class="m3-aj-t"><b>Ajustes do passeio</b><button class="icon subtle sm" data-x aria-label="Fechar">✕</button></div>
      ${linha('sens', 'Sensibilidade do mouse', .2, 3, .1, F.sens)}
      <label class="m3-aj"><span>Inverter eixo vertical</span><input type="checkbox" data-k="invY" ${CFG.invY ? 'checked' : ''}><b></b></label>
      ${linha('vel', 'Velocidade ao andar', .5, 2.5, .1, F.vel)}
      ${linha('fov', 'Campo de visão', 55, 100, 1, F.fov)}
      ${linha('olhos', 'Altura dos olhos', 150, 195, 1, F.olhos)}
      ${linha('gondola', 'Altura das gôndolas', 180, 260, 5, F.gondola)}
      <div class="m3-aj-teclas"><b>Teclas</b> W A S D andar · Shift correr · mouse olhar · clique abrir o módulo da mira · Esc soltar o mouse</div>
      <button data-padrao class="sm">Restaurar o padrão</button>`;
    S.painel.oninput = e => {
      const k = e.target.dataset.k; if (!k) return;
      CFG[k] = e.target.type === 'checkbox' ? e.target.checked : Number(e.target.value); guarda();
      const v = S.painel.querySelector(`[data-v="${k}"]`); if (v) v.textContent = F[k](CFG[k]);
      if (k === 'olhos' && S.a) S.a.alt = CFG.olhos * S.cena.e;
      if (k === 'gondola' && S.aoMudar) S.aoMudar();
      pede();
    };
    S.painel.onclick = e => {
      if (e.target.closest('[data-x]')) { S.painel.hidden = true; return; }
      if (e.target.closest('[data-padrao]')) { CFG = { ...PADRAO }; guarda(); if (S.a) S.a.alt = CFG.olhos * S.cena.e; if (S.aoMudar) S.aoMudar(); painelAjustes(); pede(); }
    };
  }
  function acertaChao(cx, cy) { const R = raio(cx, cy); if (R.d[1] > -1e-6) return null; const t = -R.o[1] / R.d[1]; return [R.o[0] + R.d[0] * t, R.o[2] + R.d[2] * t]; }
  // mover (pan): o chão acompanha o ponteiro
  function move(dx, dy) {
    const o = S.o, h = S.cv.clientHeight || 1, k = 2 * o.d * Math.tan(fov() / 2) / h, sn = Math.sin(o.th), cs = Math.cos(o.th), fy = k / Math.max(.25, Math.sin(o.ph));
    o.tx += -cs * dx * k - sn * dy * fy; o.tz += sn * dx * k - cs * dy * fy;
    const sc = S.cena; o.tx = lim(o.tx, -sc.largura * .5, sc.largura * 1.5); o.tz = lim(o.tz, -sc.altura * .5, sc.altura * 1.5);
  }
  function passa(e) {
    if (S.tw) return;
    if (preso()) { olha(e.movementX || 0, e.movementY || 0); S.destino = null; pede(); const r0 = S.cv.getBoundingClientRect(); e = { clientX: r0.left + r0.width / 2, clientY: r0.top + r0.height / 2 }; }
    const a = acerta(e.clientX, e.clientY), b = a.caixa && a.caixa.chave ? a.caixa : null;
    if (b !== S.sobre) { S.sobre = b; geometria(); pede(); }
    S.cv.style.cursor = b ? 'pointer' : '';
  }
  const preso = () => document.pointerLockElement === S.cv;
  function clique(e) {
    if (S.modo === 'andar') {
      const r = S.cv.getBoundingClientRect(), noCentro = preso();
      const a = noCentro ? acerta(r.left + r.width / 2, r.top + r.height / 2) : acerta(e.clientX, e.clientY);
      if (a.caixa && a.caixa.chave) { if (noCentro) document.exitPointerLock(); if (S.aoEscolher) S.aoEscolher(a.caixa); return; }
      if (e.pointerType === 'mouse') { if (!noCentro && S.cv.requestPointerLock) { try { const p = S.cv.requestPointerLock(); if (p && p.catch) p.catch(() => {}); } catch { /* sem trava: segue arrastando */ } } return; }
      if (a.chao) { S.destino = a.chao; pede(); }                 // toque: vai até o ponto
      return;
    }
    const a = acerta(e.clientX, e.clientY);
    if (a.caixa) { if (S.aoEscolher) S.aoEscolher(a.caixa); return; }
    if (S.aoEscolher) S.aoEscolher(null);
  }

  // ---------- API ----------
  function monta(host, { aoEscolher, aoMudar } = {}) {
    if (S && S.host === host && S.cv.isConnected) { S.aoEscolher = aoEscolher; S.aoMudar = aoMudar; return true; }
    destroi();
    host.innerHTML = '<canvas class="m3-cv" tabindex="0" aria-label="Loja em 3D: arraste para girar, role para aproximar"></canvas><div class="m3-rot" aria-hidden="true"></div><div class="m3-mira" aria-hidden="true"></div><div class="m3-manche" aria-label="Andar"><i></i></div><div class="m3-barra"></div><div class="m3-painel" hidden></div><div class="tip m3-tip" hidden></div>';
    const cv = host.querySelector('canvas'), gl = cv.getContext('webgl', { antialias: true, alpha: false });
    if (!gl) { host.innerHTML = ''; return false; }
    try {
      S = { host, cv, gl, cam: host.querySelector('.m3-rot'), barra: host.querySelector('.m3-barra'), dica: host.querySelector('.m3-tip'), painel: host.querySelector('.m3-painel'), manche_el: host.querySelector('.m3-manche'), manche: null, aoMudar, prog: programa(gl), bufT: gl.createBuffer(), bufL: gl.createBuffer(), modo: 'orbita', teclas: new Set(), aoEscolher, o: null, a: null, tw: null, raf: 0, sobre: null, rg: [], rm: [], tema: tema() };
    } catch { S = null; host.innerHTML = ''; return false; }
    gl.enable(gl.DEPTH_TEST); gl.enable(gl.CULL_FACE); gl.cullFace(gl.BACK); gl.frontFace(gl.CCW);
    gl.disable(gl.CULL_FACE);                                   // caixas sem tampa de baixo: sem descarte de faces evita erro de ordem dos vértices
    liga(); interface_();
    return true;
  }
  function cena(sc, { entrada = false } = {}) {
    if (!S) return;
    const primeira = !S.cena;
    S.cena = sc; S.sobre = null; S.tema = tema();
    const diag = Math.hypot(sc.largura, sc.altura);
    S.dMin = 60 * sc.e; S.dMax = diag * 3;
    geometria(); montaRotulos();
    if (primeira || !S.o) {
      S.o = { tx: sc.largura / 2, tz: sc.altura / 2, th: 0, ph: 1.553, d: diag * 1.2 };
      if (entrada) { S.o.d = diag * 1.35; enquadra(1100, 'iso'); } else enquadra(0, 'iso');
    }
    if (S.modo === 'andar' && S.a) S.a.alt = CFG.olhos * sc.e;
    pede();
  }
  function destroi() {
    if (!S) return;
    cancelAnimationFrame(S.raf); if (S.ro) S.ro.disconnect();
    if (S.aoTravar) document.removeEventListener('pointerlockchange', S.aoTravar);
    if (document.pointerLockElement === S.cv) document.exitPointerLock();
    const ext = S.gl.getExtension('WEBGL_lose_context'); if (ext) ext.loseContext();
    S = null;
  }
  // estado da câmera (para o link de compartilhar) e volta a ele
  const r2 = v => Math.round(v * 100) / 100;
  function estado() {
    if (!S || !S.o) return null;
    if (S.modo === 'andar' && S.a) return { m: 'a', x: r2(S.a.x), z: r2(S.a.z), Y: r2(S.a.Y), P: r2(S.a.P) };
    return { m: 'o', tx: r2(S.o.tx), tz: r2(S.o.tz), th: r2(S.o.th), ph: r2(S.o.ph), d: r2(S.o.d) };
  }
  function aplica(e, ms = 0) {
    if (!S || !e) return;
    if (e.m === 'a') { S.a = { x: e.x, z: e.z, alt: CFG.olhos * S.cena.e, Y: e.Y, P: e.P || 0, vx: 0, vz: 0 }; S.modo = 'andar'; S.tw = null; interface_(); pede(); return; }
    S.modo = 'orbita'; interface_(); orbitaPara({ tx: e.tx, tz: e.tz, th: e.th, ph: e.ph, d: e.d }, ms); pede();
  }
  return { monta, cena, destroi, ativo: () => !!S, modo: () => (S ? S.modo : null), cfg: () => CFG, estado, aplica, dados: () => (S ? S.cena : null) };
})();
