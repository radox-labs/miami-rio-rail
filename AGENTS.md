# Miami–Rio Rail

Esta cópia pertence à organização Radox e contém a aplicação, a demo pública, a API sandbox, os adaptadores e as provas específicas do corredor. O projeto original `pwsaragossy/radox-rail` permanece como registro histórico do hackathon.

## Fronteiras

- Não adicione código-fonte de contratos Soroban aqui. `custody_registry` e `transfer_agent` pertencem a `radox-labs/radox-contracts`.
- Não duplique capacidades genéricas da plataforma Radox. Autenticação, clientes, persistência, tokenização e orquestração de ativos pertencem a `radox-labs/radox-core`; o Rail deve consumi-las por API quando estiverem disponíveis.
- A API Vercel de sandbox e leitura de custódia ainda é específica desta demo e continua neste repositório até existir contrato de API equivalente no Core. Não a remova sem migrar testes, documentação OpenAPI e a demo.
- Preserve provas e afirmações históricas como observações datadas. Uma nova versão de fonte ou README não prova que a mesma versão está implantada em rede.
- Não armazene chaves privadas; as variáveis de sandbox e Resend devem ficar apenas na configuração do deploy.

Antes de mudar fronteiras entre repositórios, confirme os caminhos de build, o contrato HTTP e a compatibilidade da demo.
