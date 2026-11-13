/* ==========================================================
   tool-isabella — tutte le chiamate a Supabase, in chiaro
   Niente libreria: solo fetch() verso due servizi di Supabase.
     /auth/v1/...  -> Supabase Auth (login con codice via email)
     /rest/v1/...  -> PostgREST (le tabelle, filtrate dalla RLS)
   Ogni richiesta porta:
     apikey: <chiave pubblicabile>              (identifica il progetto)
     Authorization: Bearer <token dell'utente>  (dice CHI sta chiedendo)
   E' il token a far scattare le policy: senza login non si legge niente.
   ========================================================== */
(function () {
  "use strict";
  var CFG = window.ISABELLA_CONFIG;
  var CHIAVE_SESSIONE = "tool-isabella-sessione";   // localStorage del browser

  // ---------------- sessione salvata nel browser ----------------
  // { access_token, refresh_token, expires_at (secondi unix), email }
  function leggiSessione() {
    try { return JSON.parse(localStorage.getItem(CHIAVE_SESSIONE) || "null"); } catch (e) { return null; }
  }
  function salvaSessione(risposta) {
    var s = {
      access_token: risposta.access_token,
      refresh_token: risposta.refresh_token,
      expires_at: risposta.expires_at || Math.floor(Date.now() / 1000) + (risposta.expires_in || 3600),
      email: risposta.user && risposta.user.email
    };
    try { localStorage.setItem(CHIAVE_SESSIONE, JSON.stringify(s)); } catch (e) {}
    return s;
  }
  function cancellaSessione() {
    try { localStorage.removeItem(CHIAVE_SESSIONE); } catch (e) {}
  }

  // ---------------- richiesta generica ----------------
  async function richiesta(metodo, percorso, opzioni) {
    opzioni = opzioni || {};
    var intestazioni = { apikey: CFG.chiavePubblicabile };
    if (opzioni.token) intestazioni.Authorization = "Bearer " + opzioni.token;
    if (opzioni.corpo !== undefined) intestazioni["Content-Type"] = "application/json";
    if (opzioni.prefer) intestazioni.Prefer = opzioni.prefer;

    var risposta = await fetch(CFG.supabaseUrl + percorso, {
      method: metodo,
      headers: intestazioni,
      body: opzioni.corpo !== undefined ? JSON.stringify(opzioni.corpo) : undefined
    });
    var testo = await risposta.text();
    var dati = null;
    try { dati = testo ? JSON.parse(testo) : null; } catch (e) { dati = testo; }
    if (!risposta.ok) {
      var errore = new Error((dati && (dati.msg || dati.message || dati.error_description || dati.error)) || ("HTTP " + risposta.status));
      errore.stato = risposta.status;
      errore.codice = dati && (dati.error_code || dati.code);
      throw errore;
    }
    return dati;
  }

  // ---------------- AUTH ----------------

  // 1) Chiede a Supabase di mandare l'email di accesso.
  //    Cosa contiene l'email dipende dal template "Magic link or OTP":
  //      - template di default -> un LINK (si clicca e si torna qui, gia' loggati)
  //      - template con {{ .Token }} -> un CODICE a 6 cifre (si scrive qui)
  //    La webapp gestisce entrambi i casi.
  //    create_user:false -> non crea utenti nuovi: entra solo chi e' gia'
  //    stato aggiunto in Authentication -> Users.
  //    redirect_to -> dove riporta il link. Deve essere nella lista
  //    Authentication -> URL Configuration -> Redirect URLs, altrimenti
  //    Supabase usa il "Site URL".
  //    POST /auth/v1/otp?redirect_to=<questa pagina>  { email, create_user:false }
  function inviaCodice(email) {
    var questaPagina = location.origin + location.pathname;
    return richiesta("POST", "/auth/v1/otp?redirect_to=" + encodeURIComponent(questaPagina), {
      corpo: { email: email, create_user: false }
    });
  }

  // 1-bis) Ritorno dal LINK dell'email.
  //    Supabase verifica il link e riporta il browser qui con i token nella
  //    parte "#..." dell'indirizzo (che non viene mai mandata a nessun server):
  //      #access_token=...&refresh_token=...&expires_at=...&expires_in=3600&type=magiclink
  //    oppure, se il link e' scaduto o gia' usato:
  //      #error=access_denied&error_code=otp_expired&error_description=...
  //    Restituisce { sessione } oppure { errore } oppure null (nessun link).
  //    In ogni caso toglie i token dalla barra degli indirizzi.
  function sessioneDaLink() {
    if (!location.hash || location.hash.length < 2) return null;
    var p = new URLSearchParams(location.hash.slice(1));
    if (!p.get("access_token") && !p.get("error")) return null;
    history.replaceState(null, "", location.pathname + location.search);
    if (p.get("error")) return { errore: p.get("error_code") || p.get("error"), descrizione: p.get("error_description") };
    return {
      sessione: salvaSessione({
        access_token: p.get("access_token"),
        refresh_token: p.get("refresh_token"),
        expires_at: Number(p.get("expires_at")) || undefined,
        expires_in: Number(p.get("expires_in")) || 3600,
        user: { email: emailDalToken(p.get("access_token")) }
      })
    };
  }

  // L'access_token e' un JWT: la parte centrale (base64url) contiene l'email.
  // Serve solo per mostrarla in alto: i permessi li decide il database.
  function emailDalToken(token) {
    try {
      var centro = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
      return JSON.parse(atob(centro + "===".slice((centro.length + 3) % 4))).email || "";
    } catch (e) { return ""; }
  }

  // 2) Verifica il codice e riceve la sessione (access_token + refresh_token).
  //    POST /auth/v1/verify  { type:"email", email, token }
  async function verificaCodice(email, codice) {
    var risposta = await richiesta("POST", "/auth/v1/verify", { corpo: { type: "email", email: email, token: codice } });
    return salvaSessione(risposta);
  }

  // 3) L'access_token dura 1 ora: prima che scada se ne chiede uno nuovo.
  //    POST /auth/v1/token?grant_type=refresh_token  { refresh_token }
  async function rinnova(sessione) {
    var risposta = await richiesta("POST", "/auth/v1/token?grant_type=refresh_token", { corpo: { refresh_token: sessione.refresh_token } });
    return salvaSessione(risposta);
  }

  // Token valido da usare adesso (rinnovato se scade entro 60 secondi).
  async function tokenValido() {
    var s = leggiSessione();
    if (!s) return null;
    if (s.expires_at - 60 > Date.now() / 1000) return s.access_token;
    try { return (await rinnova(s)).access_token; }
    catch (e) { cancellaSessione(); return null; }
  }

  // 4) Esci: invalida il refresh_token lato server e pulisce il browser.
  //    POST /auth/v1/logout
  async function esci() {
    var token = await tokenValido();
    cancellaSessione();
    if (token) { try { await richiesta("POST", "/auth/v1/logout", { token: token }); } catch (e) {} }
  }

  // ---------------- DATI (PostgREST) ----------------
  // Le colonne sono elencate una per una: la migrazione da' permesso solo
  // su queste (select=* fallirebbe, perche' payload_originale e' escluso).

  var COLONNE_CHIAMATE = [
    "id", "data_chiamata", "creata_il", "numero_telefono", "nome", "azienda", "fattura", "importo",
    "urgenza", "motivo", "riassunto", "email_suggerita",
    "stato_pagamento", "note_amministrazione", "aggiornata_il", "aggiornata_da"
  ].join(",");

  var COLONNE_EMAIL = [
    "id", "ricevuta_il", "creata_il", "mittente", "destinatario", "oggetto", "corpo", "allegati",
    "numero_telefono", "chiamata_id"
  ].join(",");

  async function conToken(fn) {
    var token = await tokenValido();
    if (!token) { var e = new Error("Sessione scaduta"); e.stato = 401; throw e; }
    return fn(token);
  }

  // Chi sono? Restituisce [ {email, nome} ] se sono autorizzato, [] altrimenti.
  // GET /rest/v1/accessi_amministrazione?select=email,nome
  function mieAutorizzazioni() {
    return conToken(function (token) {
      return richiesta("GET", "/rest/v1/accessi_amministrazione?select=email,nome", { token: token });
    });
  }

  // GET /rest/v1/chiamate?select=...&order=data_chiamata.desc.nullslast,id.desc&limit=1000
  function elencoChiamate() {
    return conToken(function (token) {
      return richiesta("GET", "/rest/v1/chiamate?select=" + COLONNE_CHIAMATE +
        "&order=data_chiamata.desc.nullslast,id.desc&limit=1000", { token: token });
    });
  }

  // GET /rest/v1/email_fornitori?select=...&order=ricevuta_il.desc.nullslast,id.desc&limit=500
  function elencoEmail() {
    return conToken(function (token) {
      return richiesta("GET", "/rest/v1/email_fornitori?select=" + COLONNE_EMAIL +
        "&order=ricevuta_il.desc.nullslast,id.desc&limit=500", { token: token });
    });
  }

  // Aggiorna stato e note di UNA chiamata.
  // PATCH /rest/v1/chiamate?id=eq.<id>&aggiornata_il=<come l'ho letta>
  // Il filtro su aggiornata_il evita di sovrascrivere la modifica di un
  // collega fatta nel frattempo: se nel frattempo e' cambiata, nessuna riga
  // corrisponde e il server restituisce [] -> la webapp avvisa e ricarica.
  // aggiornata_il e aggiornata_da li scrive il database (trigger), non il browser.
  function aggiornaChiamata(id, aggiornataIlLetta, campi) {
    return conToken(async function (token) {
      var filtro = "id=eq." + encodeURIComponent(id) + "&aggiornata_il=" +
        (aggiornataIlLetta ? "eq." + encodeURIComponent(aggiornataIlLetta) : "is.null");
      var righe = await richiesta("PATCH", "/rest/v1/chiamate?" + filtro + "&select=" + COLONNE_CHIAMATE, {
        token: token,
        prefer: "return=representation",
        corpo: { stato_pagamento: campi.stato_pagamento, note_amministrazione: campi.note_amministrazione }
      });
      return righe && righe[0] ? righe[0] : null;   // null = modificata da un altro nel frattempo
    });
  }

  window.IsabellaApi = {
    leggiSessione: leggiSessione,
    inviaCodice: inviaCodice,
    sessioneDaLink: sessioneDaLink,
    verificaCodice: verificaCodice,
    tokenValido: tokenValido,
    esci: esci,
    mieAutorizzazioni: mieAutorizzazioni,
    elencoChiamate: elencoChiamate,
    elencoEmail: elencoEmail,
    aggiornaChiamata: aggiornaChiamata
  };
})();
