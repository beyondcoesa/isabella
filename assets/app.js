/* ==========================================================
   tool-isabella — interfaccia
   Tre viste: accesso (email + codice), non autorizzato, applicazione.
   Tutte le chiamate di rete sono in supabase_api.js.
   Tutto il testo che arriva dal database (detto al telefono o scritto in
   un'email da chiunque) passa da esc() prima di finire nella pagina.
   ========================================================== */
(function () {
  "use strict";
  var CFG = window.ISABELLA_CONFIG;
  var API = window.IsabellaApi;
  var $ = function (id) { return document.getElementById(id); };

  var STATI = [
    { id: "da_gestire",     nome: "Da gestire",     classe: "amber" },
    { id: "in_lavorazione", nome: "In lavorazione", classe: "info" },
    { id: "pagato",         nome: "Pagato",         classe: "pos" },
    { id: "respinto",       nome: "Respinto",       classe: "neg" }
  ];
  var FILTRI = [
    { id: "aperte",         nome: "Aperte",         stati: ["da_gestire", "in_lavorazione"] },
    { id: "da_gestire",     nome: "Da gestire",     stati: ["da_gestire"] },
    { id: "in_lavorazione", nome: "In lavorazione", stati: ["in_lavorazione"] },
    { id: "pagato",         nome: "Pagate",         stati: ["pagato"] },
    { id: "respinto",       nome: "Respinte",       stati: ["respinto"] },
    { id: "tutte",          nome: "Tutte",          stati: null }
  ];
  var URGENZE = { alta: "neg", media: "amber", bassa: "ghost" };

  var stato = {
    chiamate: [], email: [],
    filtro: "aperte", cercaChiamate: "", cercaEmail: "",
    apertaChiamata: null, apertaEmail: null,
    modificaInCorso: false, ultimoCaricamento: null
  };

  // ---------------- utilità ----------------
  function esc(v) {
    return String(v == null ? "" : v).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  var fmtGiorno = new Intl.DateTimeFormat("it-IT", { day: "2-digit", month: "short", year: "numeric", timeZone: "Europe/Rome" });
  var fmtOra = new Intl.DateTimeFormat("it-IT", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Rome" });
  function giorno(d) { return d ? fmtGiorno.format(new Date(d)) : "—"; }
  function ora(d) { return d ? fmtOra.format(new Date(d)) : ""; }
  function quando(d) { return d ? giorno(d) + " · " + ora(d) : "—"; }
  function statoDi(id) { return STATI.filter(function (s) { return s.id === id; })[0] || STATI[0]; }
  function pillStato(id) { var s = statoDi(id); return '<span class="pill ' + s.classe + '"><span class="dot"></span>' + esc(s.nome) + "</span>"; }
  function pillUrgenza(u) { return u ? '<span class="pill ' + (URGENZE[u] || "ghost") + '">' + esc(u) + "</span>" : '<span class="muto">—</span>'; }
  function kb(byte) { return byte == null ? "" : byte < 1024 ? byte + " B" : byte < 1048576 ? Math.round(byte / 1024) + " KB" : (byte / 1048576).toFixed(1) + " MB"; }
  function contiene(testo, ago) { return String(testo || "").toLowerCase().indexOf(ago) !== -1; }

  var timerToast;
  function toast(msg, tipo) {
    var t = $("toast");
    t.textContent = msg; t.className = "toast " + (tipo || ""); t.hidden = false;
    clearTimeout(timerToast); timerToast = setTimeout(function () { t.hidden = true; }, 4200);
  }

  function mostra(vista) {
    ["vista-accesso", "vista-negato", "vista-app"].forEach(function (v) { $(v).hidden = v !== vista; });
    var dentro = vista !== "vista-accesso";
    $("esci").hidden = !dentro;
    $("chi").hidden = !dentro;
  }

  // ---------------- tema (stessa chiave di Beyond) ----------------
  document.addEventListener("click", function (e) {
    if (!e.target.closest("[data-theme-toggle]")) return;
    var root = document.documentElement;
    var t = root.getAttribute("data-theme") === "dark" ? "light" : "dark";
    root.setAttribute("data-theme", t);
    try { localStorage.setItem("beyond-theme", t); } catch (x) {}
  });

  // ---------------- accesso ----------------
  var emailInCorso = "";

  function messaggioAccesso(testo, errore) {
    var a = $("avviso-accesso");
    a.textContent = testo || "";
    a.classList.toggle("errore", !!errore);
  }

  $("form-email").addEventListener("submit", async function (e) {
    e.preventDefault();
    var email = $("email").value.trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { messaggioAccesso("Scrivi un indirizzo email valido.", true); return; }
    var bottone = e.submitter || this.querySelector("button");
    bottone.disabled = true; messaggioAccesso("Invio del codice…");
    try {
      await API.inviaCodice(email);
      emailInCorso = email;
      $("form-email").hidden = true; $("form-codice").hidden = false;
      messaggioAccesso("Email inviata a " + email + ". Clicca il link che contiene, oppure scrivi qui il codice se l'email ne riporta uno. Controlla anche lo spam.");
      $("codice").focus();
    } catch (err) {
      if (err.stato === 429) messaggioAccesso("Hai chiesto troppi codici. Aspetta un minuto e riprova.", true);
      else if (err.stato === 422 || err.stato === 400) messaggioAccesso("Questa email non è abilitata. Chiedi all'IT di aggiungerti.", true);
      else messaggioAccesso("Invio non riuscito: " + err.message, true);
    } finally { bottone.disabled = false; }
  });

  $("form-codice").addEventListener("submit", async function (e) {
    e.preventDefault();
    var codice = $("codice").value.replace(/\D/g, "");
    if (codice.length < 6) { messaggioAccesso("Il codice ha 6 cifre.", true); return; }
    var bottone = this.querySelector("button[type=submit]");
    bottone.disabled = true; messaggioAccesso("Verifica…");
    try {
      await API.verificaCodice(emailInCorso, codice);
      $("codice").value = "";
      messaggioAccesso("");
      await entra();
    } catch (err) {
      messaggioAccesso(err.stato === 403 || err.stato === 400 ? "Codice errato o scaduto. Ricontrolla o chiedine uno nuovo." : "Verifica non riuscita: " + err.message, true);
    } finally { bottone.disabled = false; }
  });

  $("cambia-email").addEventListener("click", function () {
    $("form-codice").hidden = true; $("form-email").hidden = false;
    messaggioAccesso(""); $("email").focus();
  });

  async function esci() {
    await API.esci();
    stato.chiamate = []; stato.email = [];
    $("form-codice").hidden = true; $("form-email").hidden = false;
    mostra("vista-accesso");
  }
  $("esci").addEventListener("click", esci);
  $("esci-negato").addEventListener("click", esci);

  // Dopo il login: sono nella lista dell'amministrazione?
  async function entra() {
    var sessione = API.leggiSessione();
    $("chi").textContent = sessione && sessione.email || "";
    var autorizzazioni;
    try { autorizzazioni = await API.mieAutorizzazioni(); }
    catch (err) { return gestisciErrore(err); }
    if (!autorizzazioni || !autorizzazioni.length) {
      $("email-negata").textContent = sessione && sessione.email || "";
      mostra("vista-negato");
      return;
    }
    if (autorizzazioni[0].nome) $("chi").textContent = autorizzazioni[0].nome;
    mostra("vista-app");
    await carica();
  }

  function gestisciErrore(err) {
    if (err.stato === 401) { toast("Sessione scaduta: accedi di nuovo.", "errore"); esci(); return; }
    toast("Errore: " + err.message, "errore");
  }

  // ---------------- dati ----------------
  async function carica() {
    try {
      var risultati = await Promise.all([API.elencoChiamate(), API.elencoEmail()]);
      stato.chiamate = risultati[0] || [];
      stato.email = risultati[1] || [];
      stato.ultimoCaricamento = new Date();
      disegna();
    } catch (err) { gestisciErrore(err); }
  }

  $("ricarica").addEventListener("click", carica);

  // Ricarica automatica, ma non mentre qualcuno sta scrivendo una nota.
  setInterval(function () {
    if (document.hidden || $("vista-app").hidden || stato.modificaInCorso) return;
    carica();
  }, (CFG.ricaricaOgniSecondi || 60) * 1000);

  // ---------------- disegno ----------------
  function disegna() {
    $("aggiornato").textContent = stato.ultimoCaricamento ? "Aggiornato alle " + ora(stato.ultimoCaricamento) : "";
    $("conta-chiamate").textContent = stato.chiamate.filter(function (c) { return c.stato_pagamento === "da_gestire"; }).length;
    $("conta-email").textContent = stato.email.length;
    disegnaFiltri();
    disegnaChiamate();
    disegnaEmail();
  }

  function disegnaFiltri() {
    $("filtro-stati").innerHTML = FILTRI.map(function (f) {
      var n = stato.chiamate.filter(function (c) { return !f.stati || f.stati.indexOf(c.stato_pagamento) !== -1; }).length;
      return '<button type="button" data-filtro="' + f.id + '" aria-pressed="' + (stato.filtro === f.id) + '">' +
        esc(f.nome) + ' <span class="num">' + n + "</span></button>";
    }).join("");
  }

  function chiamateVisibili() {
    var f = FILTRI.filter(function (x) { return x.id === stato.filtro; })[0];
    var ago = stato.cercaChiamate.trim().toLowerCase();
    return stato.chiamate.filter(function (c) {
      if (f.stati && f.stati.indexOf(c.stato_pagamento) === -1) return false;
      if (!ago) return true;
      return [c.nome, c.azienda, c.fattura, c.numero_telefono, c.importo, c.motivo, c.riassunto, c.note_amministrazione].some(function (v) { return contiene(v, ago); });
    });
  }

  function disegnaChiamate() {
    var righe = chiamateVisibili();
    if (!righe.length) {
      $("elenco-chiamate").innerHTML = '<div class="vuoto">' + (stato.chiamate.length
        ? "Nessuna telefonata con questi filtri."
        : "Ancora nessuna telefonata salvata. Compariranno qui dopo le chiamate a Isabella in cui il fornitore acconsente agli appunti.") + "</div>";
      return;
    }
    $("elenco-chiamate").innerHTML =
      '<div class="riga intestazione" aria-hidden="true"><span>Quando</span><span>Fornitore</span><span>Fattura</span><span>Importo</span><span>Urgenza</span><span>Stato</span></div>' +
      righe.map(rigaChiamata).join("");
  }

  function rigaChiamata(c) {
    var aperta = stato.apertaChiamata === c.id;
    var chi = c.nome || c.azienda ? esc(c.nome || "") + (c.nome && c.azienda ? "<small>" + esc(c.azienda) + "</small>" : esc(c.azienda || "")) : '<span class="muto">Senza nome</span>';
    var testa =
      '<button type="button" class="riga" data-chiamata="' + c.id + '" aria-expanded="' + aperta + '">' +
        '<span class="quando"><b>' + giorno(c.data_chiamata || c.creata_il) + "</b><small>" + ora(c.data_chiamata || c.creata_il) + "</small></span>" +
        '<span class="chi-col">' + chi + "</span>" +
        '<span class="fattura" data-etichetta="Fattura">' + (c.fattura ? esc(c.fattura) : '<span class="muto">—</span>') + "</span>" +
        '<span class="importo num" data-etichetta="Importo">' + (c.importo ? esc(c.importo) : '<span class="muto">—</span>') + "</span>" +
        "<span>" + pillUrgenza(c.urgenza) + "</span>" +
        "<span>" + pillStato(c.stato_pagamento) + "</span>" +
      "</button>";
    if (!aperta) return '<div class="voce">' + testa + "</div>";

    var opzioni = STATI.map(function (s) {
      return '<label class="scelta ' + s.classe + '"><input type="radio" name="stato-' + c.id + '" value="' + s.id + '"' +
        (c.stato_pagamento === s.id ? " checked" : "") + "><span>" + esc(s.nome) + "</span></label>";
    }).join("");

    return '<div class="voce aperta">' + testa +
      '<div class="dettaglio">' +
        '<div class="colonna">' +
          '<h3>Riassunto della telefonata</h3><p class="testo">' + (c.riassunto ? esc(c.riassunto) : '<span class="muto">Nessun riassunto.</span>') + "</p>" +
          '<dl class="dati">' +
            "<dt>Motivo</dt><dd>" + (c.motivo ? esc(c.motivo) : "—") + "</dd>" +
            "<dt>Azienda</dt><dd>" + (c.azienda ? esc(c.azienda) : "—") + "</dd>" +
            "<dt>Telefono</dt><dd>" + (c.numero_telefono ? '<a href="tel:' + esc(c.numero_telefono) + '">' + esc(c.numero_telefono) + "</a>" : "nascosto") + "</dd>" +
            "<dt>Email suggerita</dt><dd>" + (c.email_suggerita ? "Sì, Isabella ha indicato fornitori@coesaenergy.com" : "No") + "</dd>" +
            "<dt>Ricevuta</dt><dd>" + quando(c.data_chiamata || c.creata_il) + "</dd>" +
          "</dl>" +
        "</div>" +
        '<form class="colonna modifica" data-modifica="' + c.id + '">' +
          '<h3>Gestione amministrazione</h3>' +
          '<fieldset class="scelte"><legend class="sr-only">Stato del pagamento</legend>' + opzioni + "</fieldset>" +
          '<label class="etichetta" for="note-' + c.id + '">Note interne</label>' +
          '<textarea id="note-' + c.id + '" name="note" rows="4" maxlength="4000" placeholder="Es. bonifico disposto il…, manca il DDT…">' + esc(c.note_amministrazione || "") + "</textarea>" +
          '<div class="salva"><button class="btn btn-primary" type="submit">Salva</button>' +
          '<span class="ultima">' + (c.aggiornata_il ? "Ultima modifica " + quando(c.aggiornata_il) + (c.aggiornata_da ? " da " + esc(c.aggiornata_da) : "") : "Mai modificata") + "</span></div>" +
        "</form>" +
      "</div></div>";
  }

  function emailVisibili() {
    var ago = stato.cercaEmail.trim().toLowerCase();
    if (!ago) return stato.email;
    return stato.email.filter(function (m) { return [m.mittente, m.oggetto, m.corpo].some(function (v) { return contiene(v, ago); }); });
  }

  function disegnaEmail() {
    var righe = emailVisibili();
    if (!righe.length) {
      $("elenco-email").innerHTML = '<div class="vuoto">' + (stato.email.length
        ? "Nessuna email trovata."
        : "Ancora nessuna email. Arriveranno qui le email a fornitori@coesaenergy.com quando lo script Gmail sarà attivo.") + "</div>";
      return;
    }
    $("elenco-email").innerHTML = righe.map(function (m) {
      var aperta = stato.apertaEmail === m.id;
      var allegati = Array.isArray(m.allegati) ? m.allegati : [];
      var testa = '<button type="button" class="riga riga-email" data-email="' + m.id + '" aria-expanded="' + aperta + '">' +
        '<span class="quando"><b>' + giorno(m.ricevuta_il || m.creata_il) + "</b><small>" + ora(m.ricevuta_il || m.creata_il) + "</small></span>" +
        '<span class="chi-col">' + esc(m.mittente || "—") + "</span>" +
        '<span class="oggetto">' + (m.oggetto ? esc(m.oggetto) : '<span class="muto">(senza oggetto)</span>') + "</span>" +
        "<span>" + (allegati.length ? '<span class="pill ghost">' + allegati.length + (allegati.length === 1 ? " allegato" : " allegati") + "</span>" : "") + "</span>" +
      "</button>";
      if (!aperta) return '<div class="voce">' + testa + "</div>";
      return '<div class="voce aperta">' + testa +
        '<div class="dettaglio dettaglio-email">' +
          '<dl class="dati"><dt>Da</dt><dd>' + esc(m.mittente || "—") + "</dd><dt>A</dt><dd>" + esc(m.destinatario || "—") + "</dd><dt>Ricevuta</dt><dd>" + quando(m.ricevuta_il) + "</dd></dl>" +
          '<pre class="corpo">' + esc(m.corpo || "(testo vuoto)") + "</pre>" +
          (allegati.length ? '<ul class="allegati">' + allegati.map(function (a) { return "<li>" + esc(a.nome) + " <small>" + kb(a.byte) + "</small></li>"; }).join("") + '</ul><p class="muto piccolo">Gli allegati restano nella casella Gmail.</p>' : "") +
        "</div></div>";
    }).join("");
  }

  // ---------------- interazioni ----------------
  document.addEventListener("click", function (e) {
    var filtro = e.target.closest("[data-filtro]");
    if (filtro) { stato.filtro = filtro.getAttribute("data-filtro"); disegnaFiltri(); disegnaChiamate(); return; }

    var rc = e.target.closest("[data-chiamata]");
    if (rc) {
      var id = Number(rc.getAttribute("data-chiamata"));
      if (stato.modificaInCorso && stato.apertaChiamata !== id && !confirm("Hai modifiche non salvate. Chiudere comunque?")) return;
      stato.apertaChiamata = stato.apertaChiamata === id ? null : id;
      stato.modificaInCorso = false;
      disegnaChiamate();
      return;
    }
    var re = e.target.closest("[data-email]");
    if (re) {
      var idm = Number(re.getAttribute("data-email"));
      stato.apertaEmail = stato.apertaEmail === idm ? null : idm;
      disegnaEmail();
    }
  });

  document.addEventListener("input", function (e) {
    if (e.target.closest("[data-modifica]")) stato.modificaInCorso = true;
  });
  document.addEventListener("change", function (e) {
    if (e.target.closest("[data-modifica]")) stato.modificaInCorso = true;
  });

  document.addEventListener("submit", async function (e) {
    var form = e.target.closest("[data-modifica]");
    if (!form) return;
    e.preventDefault();
    var id = Number(form.getAttribute("data-modifica"));
    var c = stato.chiamate.filter(function (x) { return x.id === id; })[0];
    var scelto = form.querySelector('input[type=radio]:checked');
    var note = form.querySelector("textarea").value.trim();
    var bottone = form.querySelector("button[type=submit]");
    bottone.disabled = true;
    try {
      var aggiornata = await API.aggiornaChiamata(id, c.aggiornata_il, {
        stato_pagamento: scelto ? scelto.value : c.stato_pagamento,
        note_amministrazione: note || null
      });
      stato.modificaInCorso = false;
      if (!aggiornata) {
        toast("Un collega ha modificato questa chiamata nel frattempo: ricarico i dati, controlla e riprova.", "errore");
        await carica();
        return;
      }
      stato.chiamate = stato.chiamate.map(function (x) { return x.id === id ? aggiornata : x; });
      toast("Salvato: " + statoDi(aggiornata.stato_pagamento).nome + ".", "ok");
      disegna();
    } catch (err) { gestisciErrore(err); }
    finally { bottone.disabled = false; }
  });

  $("cerca-chiamate").addEventListener("input", function () { stato.cercaChiamate = this.value; disegnaChiamate(); });
  $("cerca-email").addEventListener("input", function () { stato.cercaEmail = this.value; disegnaEmail(); });

  // Schede Telefonate / Email
  ["chiamate", "email"].forEach(function (nome) {
    $("tab-" + nome).addEventListener("click", function () {
      ["chiamate", "email"].forEach(function (n) {
        $("tab-" + n).setAttribute("aria-selected", String(n === nome));
        $("pannello-" + n).hidden = n !== nome;
      });
    });
  });

  window.addEventListener("beforeunload", function (e) {
    if (stato.modificaInCorso) { e.preventDefault(); e.returnValue = ""; }
  });

  // ---------------- avvio ----------------
  $("link-beyond").href = CFG.urlBeyond || "#";
  (async function avvio() {
    // Arrivo dal link dell'email? (token nella parte "#..." dell'indirizzo)
    var link = API.sessioneDaLink();
    if (link && link.errore) {
      mostra("vista-accesso");
      messaggioAccesso(link.errore === "otp_expired"
        ? "Il link è scaduto o è già stato usato. Chiedine uno nuovo."
        : "Accesso dal link non riuscito: " + (link.descrizione || link.errore), true);
      return;
    }
    var token = await API.tokenValido();
    if (token) await entra();
    else mostra("vista-accesso");
  })();
})();
