# Miami–Rio Rail

Esta cópia pertence à organização Radox e contém a aplicação, a demo pública, a API sandbox, os adaptadores e as provas específicas do corredor. O projeto original `pwsaragossy/radox-rail` permanece como registro histórico do hackathon.

## Fronteiras

- Não adicione código-fonte de contratos Soroban aqui. `custody_registry` e `transfer_agent` pertencem a `radox-labs/radox-contracts`.
- A versão consumida fica em `contracts.lock.json` (commit do radox-contracts, sha256 do wasm e contract IDs). Os scripts leem os hashes por `scripts/lib/contracts-lock.mjs`; não volte a escrever hashes nos scripts, e passe sempre a rede: `wasmHash(nome, { network: "testnet" | "mainnet" })`. Com `mainnet`, o próprio leitor recompila o lock inteiro e aborta antes de qualquer envio se algo divergir; não contorne isso (nada de hash de mainnet fora do `wasmHash`). Só `mainnet-deploy` e `mainnet-rehearsal` podem usar mainnet; todo o outro script que importa `lib/stellar.mjs` chama `testnetOnly()` logo depois dos imports. Cada entrada é uma variante de build: `features` (lista exata, sempre com `--no-default-features`; nunca `testing`), `network` e o `wasm_sha256` dessa variante; a única feature aceita é a de rede da própria entrada, e `default` é recusado; `legacy: true` marca um wasm instalado que não se reproduz do commit (hoje só o `transfer_agent` de testnet). Depois de mudar o lock, corra `npm run verify-contracts-lock` (chain, só leitura) e `npm run verify-contracts-lock -- --rebuild` (checkout limpo do commit, build e sha256); os dois saem com código ≠ 0 em qualquer divergência. Não escreva `reproducible` à mão sem o `--rebuild` verde.
- Não duplique capacidades genéricas da plataforma Radox. Autenticação, clientes, persistência, tokenização e orquestração de ativos pertencem a `radox-labs/radox-core`; o Rail deve consumi-las por API quando estiverem disponíveis.
- A API Vercel de sandbox e leitura de custódia ainda é específica desta demo e continua neste repositório até existir contrato de API equivalente no Core. Não a remova sem migrar testes, documentação OpenAPI e a demo.
- Preserve provas e afirmações históricas como observações datadas. Uma nova versão de fonte ou README não prova que a mesma versão está implantada em rede.
- Não armazene chaves privadas; as variáveis de sandbox e Resend devem ficar apenas na configuração do deploy.

Antes de mudar fronteiras entre repositórios, confirme os caminhos de build, o contrato HTTP e a compatibilidade da demo.
