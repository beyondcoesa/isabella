/* ==========================================================
   tool-isabella — configurazione
   Questi due valori sono PUBBLICI per definizione (finiscono nel browser).
   La chiave "pubblicabile" da sola non legge nulla: le tabelle si aprono
   solo con il login (token dell'utente) e solo per le email elencate in
   accessi_amministrazione (vedi supabase/migrations/).
   La service role NON va mai messa qui.
   ========================================================== */
window.ISABELLA_CONFIG = {
  // Progetto Supabase "Isabella-fornitori" (Project Settings -> API)
  supabaseUrl: "https://yvyuzilsvrdbrlobawyi.supabase.co",
  chiavePubblicabile: "sb_publishable_ulqQPsnRi5ONp8r63hKprg_xaCMibHw",

  // Link "Torna a Beyond" nella barra in alto
  urlBeyond: "https://beyondcoesa.github.io/",

  // Ricarica automatica dei dati (secondi) mentre la pagina e' aperta e visibile
  ricaricaOgniSecondi: 60
};
