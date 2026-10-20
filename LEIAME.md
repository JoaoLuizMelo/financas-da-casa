# Finanças da Casa — como publicar (100% gratuito)

Aplicativo web instalável no celular, com login individual por e-mail e senha.
Tudo roda em planos gratuitos:

| Parte | Serviço | Custo |
|---|---|---|
| Site, login e banco de dados | Firebase (plano Spark) | Gratuito, sem cartão de crédito |
| Leitura de nota por foto | Tesseract.js, no próprio celular | Gratuito |
| Aviso diário no WhatsApp | GitHub Actions + CallMeBot | Gratuito |

O plano gratuito do Firebase cobre com muita folga o uso de uma família. Os limites diários são de dezenas de milhares de leituras e gravações.

---

## 1. Criar o projeto no Firebase (cerca de 10 min)

1. Acesse **console.firebase.google.com** com seu Gmail e clique em **Criar um projeto**.
   - Nome sugerido: `financas-da-casa`. Anote o **ID do projeto** que aparece abaixo do nome, por exemplo `financas-da-casa-a1b2c`.
   - O Google Analytics pode ficar desativado.
2. **Login:** no menu lateral, vá em **Criação → Authentication → Vamos começar → E-mail/senha**. Ative a primeira opção e salve.
3. **Banco de dados:** vá em **Criação → Firestore Database → Criar banco de dados**.
   - Local: **southamerica-east1 (São Paulo)**.
   - Modo: **produção**. As regras do projeto substituem as padrão no passo 3.
4. **Registrar o app web:** em **Configurações do projeto** (ícone de engrenagem) → **Seus apps** → ícone **`</>`**.
   - Apelido: `Finanças da Casa`. **Não** marque o Firebase Hosting nessa tela.
   - O Firebase mostra um bloco `firebaseConfig = { apiKey: ..., ... }`. Copie os valores para o arquivo **`public/firebase-config.js`**, substituindo os campos `COLE_AQUI` / `SEU-PROJETO`.
5. Abra o arquivo **`.firebaserc`** e troque `SEU-PROJETO` pelo ID do projeto.

## 2. Instalar as ferramentas no computador (uma vez só)

1. Instale o **Node.js LTS** pelo site nodejs.org.
2. Abra o Prompt de Comando (Windows) ou o Terminal (Mac) e execute:
   ```
   npm install -g firebase-tools
   firebase login
   ```
   O navegador abre para você autorizar com o mesmo Gmail.

## 3A. Publicar sem instalar nada (GitHub Pages — recomendado)
1. Crie uma conta gratuita em **github.com**.
2. Crie um repositório **público** chamado `financas-da-casa`.
   - No plano gratuito, o GitHub Pages só funciona em repositório público.
   - O código fica visível, mas os dados não: eles estão protegidos pelas regras do Firebase.
3. Na página do repositório, clique em **uploading an existing file**.
   - Arraste **todo o conteúdo** da pasta `financas-da-casa`, incluindo a pasta `.github`.
   - Clique em **Commit changes**.
4. Vá em **Settings → Pages** e, em *Source*, escolha **GitHub Actions**.
5. Vá em **Actions → Publicar site → Run workflow**. Em cerca de 1 minuto, o site fica em:
   **`https://SEU-USUARIO.github.io/financas-da-casa/`**
6. No Firebase, libere esse endereço para o login:
   - Vá em **Authentication → Configurações → Domínios autorizados → Adicionar domínio**.
   - Informe `SEU-USUARIO.github.io`.

Sempre que você enviar arquivos novos da pasta `public/`, o site se atualiza sozinho.

## 3B. Publicar pelo Firebase Hosting (alternativa, exige Node.js — passo 2)

No terminal, entre na pasta do projeto e publique:
```
cd caminho\para\financas-da-casa
firebase deploy
```
Ao final, aparece o endereço do app: **`https://SEU-PROJETO.web.app`**.

Esse comando publica o site e as regras de segurança do banco. Repita-o sempre que alterar algum arquivo.

## 4. Primeiro uso

1. Abra o endereço no celular e toque em **Criar conta**. Faça o mesmo no celular da sua esposa, com o e-mail dela.
2. **Balanço do casal:**
   - Cada um vai em **Conta e compartilhamento → Compartilhar meus dados** e informa o e-mail do outro.
   - O chip **"Balanço: eu + …"** aparece para quem recebeu o compartilhamento.
   - Se só um compartilhar, só o outro vê o balanço conjunto.
3. **Cartão da esposa:**
   - Ela cadastra o cartão em **Cartões → Cadastrar cartão**.
   - Depois, toca no nome do cartão e autoriza o seu e-mail em **Quem pode lançar compras neste cartão**.
   - A partir daí, você registra suas compras nele. Ela vê na fatura quanto é seu, e você não vê as compras dela, a menos que ela compartilhe os dados.
4. **Bloquear cadastros de estranhos**, depois que todos tiverem conta:
   - No Firebase, vá em **Authentication → Configurações → Ações do usuário**.
   - Desmarque **Ativar criação (inscrição)**.
   - Para incluir alguém depois, marque de novo, deixe a pessoa se cadastrar e desmarque.

## 5. Instalar como aplicativo no celular

- **Android (Chrome):** menu ⋮ → **Adicionar à tela inicial** (ou **Instalar app**).
- **iPhone (Safari):** botão Compartilhar → **Adicionar à Tela de Início**.

## 6. Aviso automático no WhatsApp (opcional, cerca de 15 min)

### 6.1 Ativar o CallMeBot no seu número
1. Siga as instruções em **callmebot.com**, seção *Free WhatsApp API*:
   - Salve o número do CallMeBot indicado lá nos seus contatos.
   - Envie a ele, pelo WhatsApp, a mensagem de ativação mostrada no site.
2. Você recebe de volta a sua **apikey**, um número curto.
3. No app, vá em **Conta e compartilhamento → Avisos no WhatsApp**. Informe seu número, a quantidade de dias de antecedência e a apikey, e salve.

Sua esposa faz o mesmo no número dela, se quiser receber os avisos dela.

### 6.2 Agendar o envio diário (GitHub)
1. Crie uma conta gratuita em **github.com** e um repositório **privado**, por exemplo `financas-da-casa`.
2. Envie todos os arquivos desta pasta para o repositório. O botão **Add file → Upload files** permite arrastar a pasta inteira, incluindo `.github`.
3. No Firebase, gere a chave da conta de serviço:
   - Vá em **Configurações do projeto → Contas de serviço → Gerar nova chave privada**.
   - Baixe o arquivo JSON. Ele é sigiloso: não envie para o repositório nem compartilhe.
4. No GitHub, cadastre a chave como segredo:
   - No repositório, vá em **Settings → Secrets and variables → Actions → New repository secret**.
   - Nome: `FIREBASE_SERVICE_ACCOUNT`.
   - Valor: cole **todo o conteúdo** do arquivo JSON.
5. Teste o envio:
   - Vá em **Actions → Lembretes de vencimento → Run workflow**.
   - Marque **Enviar mensagem de teste** e confirme. A mensagem chega no seu WhatsApp em até 1 minuto.

Depois disso, o aviso sai **todo dia às 7h40**, e só quando houver contas vencendo dentro do prazo escolhido ou atrasadas.

Para mudar o horário, edite a linha `cron` em `.github/workflows/lembretes.yml`. O horário é em UTC: some 3 horas ao horário de Recife.

---

## Como os dados ficam protegidos
- Cada pessoa só lê e grava os próprios lançamentos. Isso é garantido pelo servidor (`firestore.rules`), não só pela tela.
- Outra pessoa só vê seus dados se **você** a adicionar em *Compartilhar meus dados*. O acesso pode ser removido a qualquer momento.
- O número do WhatsApp e a chave do CallMeBot ficam numa área que só o dono enxerga.
- O titular de um cartão vê todas as compras feitas nele. Quem lança compras no cartão de outra pessoa vê apenas as próprias compras.

## Estrutura dos arquivos
```
public/              site publicado
  index.html         telas
  styles.css         visual (tema claro e escuro)
  app.js             funcionamento do app
  nucleo.js          regras: plano de contas, faturas, parcelas e vencimentos
  ocr.js             leitura de nota (valor, data, CNPJ, QR Code da NFC-e)
  firebase-config.js configuração do seu projeto (passo 1.4)
  sw.js, manifest.webmanifest, icon-*.png   instalação no celular
firestore.rules      regras de acesso aos dados
firebase.json        configuração da publicação
lembretes/           script do aviso no WhatsApp
.github/workflows/   agendamento diário do aviso
```

## Alterar o plano de contas
As categorias ficam no início de `public/nucleo.js`, na constante `PLANO`. Inclua itens nas listas `i: [...]` e publique de novo com `firebase deploy`.

Evite renomear categorias já usadas: os lançamentos antigos guardam o nome da categoria.
