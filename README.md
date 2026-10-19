# Controle de Validade

Dashboard + mapa de calor da loja + coletor com leitura de código de barras pela câmera. Substitui a planilha `Controle_Validade_v12.xlsx`, que continua sendo **entrada** (importação) e **saída** (exportação).

## Rodar no seu computador

Node 20 ou mais novo.

```bash
npm install
npm run import -- "../Controle_Validade_v12.xlsx"   # carga inicial (já feita neste PC)
npm start                                           # http://localhost:3000  ·  coletor em /coletor
npm test
```

Localmente o banco é o arquivo `data/validade.db` e o login fica desligado (só o localhost acessa). Com `npm run lan` ou `REQUIRE_LOGIN=1` o login passa a ser obrigatório.

## Publicar (Git + Vercel)

A Vercel não guarda arquivos entre chamadas, então em produção o banco é o **Turso** (SQLite hospedado, plano gratuito serve). O código é o mesmo; só muda a variável de ambiente.

1. **Banco** — crie um banco no Turso (pelo painel da Vercel em *Storage / Marketplace → Turso*, ou `turso db create validade`). Anote `TURSO_DATABASE_URL` (`libsql://…`) e `TURSO_AUTH_TOKEN`.
2. **Git** — `git init`, commit e push para um repositório **privado**. O `.gitignore` já deixa de fora `node_modules`, `data/` e `.env`.
3. **Vercel** — *Add New → Project*, escolha o repositório. Preset **Other**, sem comando de build. Em *Environment Variables* crie:

   | Variável | Valor |
   |---|---|
   | `TURSO_DATABASE_URL` | `libsql://…` do passo 1 |
   | `TURSO_AUTH_TOKEN` | token do passo 1 |
   | `SESSION_SECRET` | texto aleatório com 32+ caracteres (`node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`) |

4. **Dados e primeiro acesso** — no seu computador, com as mesmas variáveis `TURSO_*` definidas no terminal:

   ```bash
   npm run import -- "../Controle_Validade_v12.xlsx"   # sobe produtos e estoque para o Turso
   npm run usuario -- MICHEL 123456 admin               # troque pelo PIN que quiser (6 a 8 números)
   npm run usuario -- JOAO 654321 operador              # um por pessoa da loja
   ```

5. Abra o endereço da Vercel no celular ou no Chrome do coletor, entre com nome + PIN e use **Adicionar à tela inicial**. O endereço é HTTPS, que é o que libera a câmera.

Na Vercel o login é sempre obrigatório. Depois, novos usuários e PINs se gerenciam em **Configurações → Equipe**.

### Segurança embutida

PIN com hash (scrypt) e bloqueio de 10 min após 5 erros · sessão em cookie `HttpOnly`/`Secure`/`SameSite=Lax` assinado · o nome do operador nos lançamentos vem da sessão, não do que o aparelho manda · cabeçalho obrigatório contra CSRF · Content-Security-Policy restritiva · câmera liberada só para o próprio site · operador não altera regras, planta, equipe nem importa dados.

## Endereço

`GÔNDOLA-LADO-PRATELEIRA`, por exemplo `1-B-3`.

| Parte | Valores |
|---|---|
| Gôndola | 1 a 40 (hoje 1 a 19; sacaria e aquarismo entram depois) |
| Lado | `A` esquerda · `B` direita · `F` ponta da frente · `C` ponta das costas |
| Prateleira | 1 a 5. Ponta pode vir sem prateleira: `1-F`, `1-C` |

Endereços antigos fora disso (`19`, `4-E-1`) continuam no estoque, aparecem em **Qualidade dos dados** e no mapa como “sem endereço válido”, e se corrigem na próxima ronda. Endereço novo fora do padrão é recusado.

## Regra de prevenção (Configurações → Regras de desconto)

| Prazo | Desconto |
|---|---|
| até 30 dias | 50% em tudo |
| até 90 dias | ração (seca e úmida) 20% · demais itens 30% |
| vencido | retirar da loja |

“Ração” vem da categoria do produto; sem categoria, do nome. Não existe mais a faixa de 10%. Perda potencial = valor × desconto (vencido = 100%).

## Telas

- **Visão geral** — valor em risco, validade do estoque (donut), muro de validade por mês, “fazer hoje”, gôndolas que pedem atenção, marcas, qualidade dos dados.
- **Mapa da loja** — planta com calor por gôndola; clique para ver lados A/B, pontas e cada prateleira, e os lotes dela. Métricas: Risco, Validade, Ocupação, Ronda. **Editar planta** (administrador): arraste e redimensione as gôndolas, gire, envie a imagem do layout da loja como fundo, escolha se a prateleira 1 é a de cima ou a de baixo. Enquanto não for salva, a planta é uma grade provisória.
- **Estoque**, **Etiquetas** (imprimir), **Movimentações** (com desfazer), **Configurações** (regras, equipe, importar/exportar).
- **Coletor** (`/coletor`) — Entrada (receber soma / contar define), Ronda por endereço, Baixa, Buscar. Atalhos de lado e prateleira por toque, câmera para o EAN e para a etiqueta do endereço, fila offline com reenvio sem duplicar, desfazer do último lançamento, aviso de FEFO.

## Câmera

Usa o leitor nativo do Chrome (BarcodeDetector) e, onde ele não existe, o ZXing (`public/vendor/zxing.min.js`). Para EAN só aceita leitura com dígito verificador correto. Exige HTTPS (ou localhost).

## Modelo de dados

`produtos` · `lotes` (EAN + lote + validade + **endereço**) · `eventos` (toda entrada, contagem, ajuste, baixa e transferência, com quem/quando/saldo) · `usuarios` · `config`.

## Limites conhecidos

- Não lê vendas do PDV, então o saldo só diminui por baixa ou ronda — por isso a Ronda existe.
- Importar pelo painel aceita arquivos de até ~4 MB (limite da Vercel); a carga grande vai por `npm run import`.
- A câmera foi testada com leitura de imagens de código de barras, não com um aparelho real de loja.
- `npm audit` aponta 2 avisos moderados de `uuid` dentro do `exceljs`; o trecho afetado não é usado aqui.
