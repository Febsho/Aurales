import { Link, useNavigate } from 'react-router-dom'

const Section = ({ id, title, children }: { id: string; title: string; children: React.ReactNode }) => (
  <section id={id} className="scroll-mt-6 rounded-2xl border border-white/10 bg-white/[.035] p-5 sm:p-7">
    <h2 className="mb-4 text-xl font-bold text-white">{title}</h2>
    <div className="space-y-4 text-sm leading-7 text-white/70">{children}</div>
  </section>
)

function Code({ children }: { children: string }) {
  return <pre className="overflow-x-auto rounded-xl border border-white/10 bg-black/50 p-4 text-xs leading-6 text-emerald-100"><code>{children}</code></pre>
}

export default function DocumentationPage() {
  const navigate = useNavigate()
  return (
    <div className="app-content-frame mx-auto max-w-5xl space-y-6 px-4 py-6 pb-28 sm:px-8 sm:py-10">
      <header className="flex items-center gap-4">
        <button type="button" onClick={() => navigate(-1)} aria-label="Back" className="grid h-11 w-11 shrink-0 place-items-center rounded-full border border-white/10 bg-white/[.06] text-white hover:bg-white/10">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-5 w-5" aria-hidden="true"><path d="m15 18-6-6 6-6" strokeLinecap="round" strokeLinejoin="round" /></svg>
        </button>
        <div><p className="text-xs font-semibold uppercase tracking-[.22em] text-accent">Aurales Web</p><h1 className="text-2xl font-black tracking-tight text-white sm:text-4xl">Self-Hosting & Webplayer</h1></div>
      </header>

      <p className="max-w-3xl text-sm leading-7 text-white/65">Diese Anleitung beschreibt die Webversion, den kombinierten Docker-Stack und die Funktionsweise des Browserplayers. Die vollständigen Betriebsdetails und Beispiele bleiben zusätzlich in den Dateien <code>docs/self-hosted-stack.md</code> und <code>docs/media-worker.md</code> im Repository verfügbar.</p>

      <nav aria-label="Auf dieser Seite" className="flex flex-wrap gap-2">
        {[["requirements", "Voraussetzungen"], ["deploy", "Installation"], ["worker", "Media Worker"], ["player", "Webplayer"], ["integrations", "Dienste verbinden"], ["troubleshooting", "Fehlerbehebung"]].map(([id, label]) => <a key={id} href={`#${id}`} className="rounded-full border border-white/10 bg-white/[.04] px-3 py-1.5 text-xs font-semibold text-white/75 hover:bg-white/10">{label}</a>)}
      </nav>

      <Section id="requirements" title="Was du brauchst">
        <ul className="list-disc space-y-1 pl-5">
          <li>Für Docker: einen Linux-Server mit Docker Engine und Docker Compose Plugin.</li>
          <li>Für eine öffentliche Installation: einen DNS-Namen, der auf den Server zeigt, und erreichbare Ports TCP 80/443. Caddy stellt darüber automatisch HTTPS bereit.</li>
          <li>Für statisches Hosting: Node.js 22 zum Bauen, einen Webserver/CDN und eine HTTPS-Adresse mit SPA-Fallback auf <code>index.html</code>.</li>
          <li>Für den optionalen Webplayer-Worker: genaue Hostnamen der erlaubten Stream-CDNs. Ohne Allowlist bleiben Proxy und Konvertierung deaktiviert.</li>
        </ul>
        <p>HTTPS ist für PWA-Installation, sichere Browserfunktionen und Medienzugriff erforderlich. Browser auf privaten LAN-Adressen können je nach Browser HTTPS oder localhost-Ausnahmen benötigen.</p>
      </Section>

      <Section id="deploy" title="Komplette Webversion mit Docker starten">
        <p>Der Compose-Stack baut die Web-App und den Rust Media Worker aus demselben Checkout. Caddy stellt die App bereit und leitet nur <code>/health</code> und <code>/v1/*</code> intern an den Worker weiter. Der Worker-Port wird nicht öffentlich freigegeben.</p>
        <Code>{`git clone --branch master https://github.com/Febsho/Aurales.git Aurales
cd Aurales
cp .env.docker.example .env
openssl rand -hex 32   # AURALES_MEDIA_API_KEY
openssl rand -hex 32   # AURALES_MEDIA_SESSION_KEY
openssl rand -hex 24   # AURALES_MEDIA_ACCESS_CODE
chmod 600 .env
docker compose up -d --build
docker compose ps
docker compose logs --tail=100 web media-worker`}</Code>
        <p>Trage die erzeugten Werte in die passenden Variablen in <code>.env</code> ein. Setze außerdem <code>AURALES_DOMAIN</code> und bei aktiviertem Proxy <code>AURALES_MEDIA_ALLOWED_HOSTS</code> mit exakten Hostnamen, zum Beispiel <code>cdn.example.net,video.example.org</code>. Keine Wildcards verwenden.</p>
        <p>Öffne danach <code>https://deine-domain.example</code>. Für Updates: im Repository <code>git pull</code>, dann <code>docker compose up -d --build</code>. Caddy-Zertifikate und Worker-Konvertierungen liegen in Docker-Volumes.</p>
      </Section>

      <Section id="static" title="Nur die Web-App statisch hosten">
        <p>Wenn du keinen integrierten Worker brauchst, kannst du den Browserclient getrennt bauen und ausliefern:</p>
        <Code>{`npm ci
npm run build:web
# Den Inhalt von dist-web/ auf einen HTTPS-Webhost kopieren`}</Code>
        <p>Der Host muss unbekannte Pfade wie <code>/settings</code>, <code>/series/…</code> und <code>/catalog/…</code> auf <code>/index.html</code> zurückführen. Eine Nginx-Vorlage liegt unter <code>deploy/nginx/aurales-web.conf</code>. Vite-Konfigurationen wie <code>VITE_TMDB_API_KEY</code> oder OAuth Client IDs werden in den Browser-Build eingebettet und sind öffentlich sichtbar. Dort niemals Client Secrets, Passwörter oder private Worker-Schlüssel eintragen.</p>
        <p>Für OAuth müssen die exakten HTTPS-Callback-URLs der Installation beim jeweiligen Anbieter registriert werden. Bei statischem Hosting ohne integrierten Worker muss der Aurales-Sync-Server außerdem den exakten Origin in seiner CORS-Konfiguration zulassen.</p>
      </Section>

      <Section id="worker" title="Media Worker aktivieren">
        <ol className="list-decimal space-y-1 pl-5">
          <li>Setze <code>AURALES_MEDIA_API_KEY</code> und <code>AURALES_MEDIA_SESSION_KEY</code> auf unterschiedliche zufällige Werte mit mindestens 32 Zeichen.</li>
          <li>Setze einen eigenen <code>AURALES_MEDIA_ACCESS_CODE</code> mit mindestens 16 Zeichen und begrenze <code>AURALES_MEDIA_ALLOWED_HOSTS</code> auf bekannte Medien-CDNs.</li>
          <li>Starte den Stack und prüfe <code>docker compose ps</code>; der Worker muss gesund sein.</li>
          <li>Öffne in Aurales <strong>Einstellungen → Player → Aurales media service</strong>, gib den Access Code ein und wähle „Unlock service“ auf jedem Browsergerät.</li>
        </ol>
        <p>Der Browser erhält nach dem Freischalten ein same-origin HttpOnly Cookie. API- und Signaturschlüssel bleiben auf dem Server. Zum Sperren aller Sitzungen Access Code und Session Key ändern und den Worker neu erstellen.</p>
        <p>Der Worker kann erlaubte direkte Dateien, statische HLS-/DASH-VOD-Quellen und begrenzte Live-HLS-/DASH-Snapshots mit FFmpeg in browserfreundlichere Formate umwandeln. Er unterstützt HLS-Varianten, Segment- und Init-Map-Byte-Ranges, Playlist-Variablen, Identity-AES-128, bis zu acht externe HLS-/DASH-Audiospuren und Untertitel-Renditions sowie DASH-Segmentlisten, einzelne Dateien mit SegmentBase und begrenzte Segmentvorlagen über mehrere Perioden. Dynamische DASH-Manifeste mit begrenzten Segmentlisten oder zeitlich begrenzten Segmentvorlagen werden als Momentaufnahme umgewandelt; unbegrenzte Live-Vorlagen bleiben ausgeschlossen. Endliche Live-HLS-Playlists mit vollständigen Segmenten können bei inkompatiblen Browser-Codecs als Momentaufnahme konvertiert werden. Bei Low-Latency-HLS übernimmt der Worker nach Möglichkeit vollständige Segmente und zusätzlich Parts ab dem ersten mit INDEPENDENT=YES; Preload-Hinweise werden ignoriert. Part-only-Playlists benötigen mindestens einen unabhängigen Part, Delta-Updates bleiben ausgeschlossen. Bei SegmentBase wird die vollständige Mediendatei an FFmpeg übergeben; separat gehostete Initialisierungsdateien aus dem MPD werden ebenfalls geladen. Relative HLS- und DASH-Referenzen übernehmen fehlende Query-Parameter derselben Origin; AWS-signierte Links bleiben unverändert. Bis zu acht eingebettete oder externe HLS-/DASH-Textuntertitel werden als WebVTT für den Player bereitgestellt; bildbasierte Untertitel bleiben unkonvertiert. Für mobile MP4-Ausgaben nutzt der letzte Video-Fallback H.264 Baseline und begrenzt die längste Bildkante auf 1920 Pixel; Remux und Audiokonvertierung behalten das Quellvideo bei. MP4-Audiotranscodes nutzen AAC-LC und mischen für bessere Mobilkompatibilität auf Stereo herunter; Stream-Copy erhält das ursprüngliche Kanal-Layout. MP4 behält alle Audiospuren, sofern sie konvertiert werden können; andernfalls versucht der Worker die einzelnen Spuren der Reihe nach. Live-HLS wird weiterhin über den Worker-Proxy durchgereicht; LL-HLS-Reload-Parameter bleiben dabei erhalten. DRM wird nicht konvertiert. Der Worker umgeht keine Anmeldung, abgelaufenen Links oder fehlenden Berechtigungen.</p>
      </Section>

      <Section id="player" title="Wie der Webplayer funktioniert">
        <p>Die Webversion nutzt den gemeinsamen Aurales Browserplayer mit dem HTML-Videoelement. Er versucht zuerst den Stream direkt abzuspielen. Unterstützte HLS-Streams laufen nativ im Browser oder über HLS.js mit Media Source Extensions.</p>
        <ul className="list-disc space-y-1 pl-5">
          <li>Direct Play hängt von Container, Video-/Audiocodec, Browser und Gerät ab.</li>
          <li>Audio- und Untertitelauswahl, Wiedergabefortschritt, Resume, Streamwechsel, Fallback und Next Episode werden von Aurales verwaltet.</li>
          <li>Signierte URLs, HTTP Range und CORS müssen vom jeweiligen Anbieter beziehungsweise dessen CDN unterstützt werden. Bei Jellyfin müssen Browser-Origin und angeforderte Header/Methoden erlaubt sein.</li>
          <li>Bei nicht unterstütztem Format kann der optionale Worker Remuxing oder Transcoding anbieten. Das lädt die Quelle zunächst vollständig herunter und kann daher Speicherplatz und Zeit benötigen.</li>
          <li>DRM, mpv-spezifische Funktionen, manche Untertitelformate sowie HDR/Dolby Vision sind nicht browserübergreifend verfügbar. AirPlay und Picture-in-Picture erscheinen nur, wenn der Browser die jeweilige API bereitstellt.</li>
        </ul>
        <p>Beim Testen möglichst eine autorisierte Quelle mit unterstütztem Codec und korrekten CORS-/Range-Headern verwenden. Browser-Entwicklertools → Network zeigen, ob Streamabrufe an CORS, HTTP 403/404 oder fehlenden Byte-Ranges scheitern.</p>
      </Section>

      <Section id="integrations" title="Jellyfin und andere Dienste verbinden">
        <p>Jellyfin wird in Aurales unter <strong>Einstellungen → Sources</strong> hinzugefügt. Die Server-URL muss aus dem Browser erreichbar sein. Bei Nutzung über eine andere Domain muss Jellyfin oder der Reverse Proxy den Aurales-Origin, die nötigen HTTP-Methoden und Authorization-/Content-Type-Header erlauben. Für Streams muss auch der Medienhost vom Browser erreichbar sein.</p>
        <p>Ein Jellyfin API Key kann je nach Serveraktionen weniger Rechte haben als ein Benutzerzugang. Für persönliche Wiedergabe- und Watch-Status-Synchronisierung sollte die Verbindung mit einem passenden Benutzerzugang eingerichtet sein. Zugangsdaten werden nicht in den öffentlichen Web-Build geschrieben.</p>
        <p>Weitere Details zu Worker-Routen, Umgebungsvariablen und separatem Betrieb stehen in der <a className="text-accent underline" href="https://github.com/Febsho/Aurales/blob/master/docs/media-worker.md" target="_blank" rel="noreferrer">Media-Worker-Dokumentation</a> und der <a className="text-accent underline" href="https://github.com/Febsho/Aurales/blob/master/docs/self-hosted-stack.md" target="_blank" rel="noreferrer">Docker-Compose-Anleitung</a>.</p>
      </Section>

      <Section id="troubleshooting" title="Fehler schnell eingrenzen">
        <ul className="list-disc space-y-1 pl-5">
          <li>App lädt nur auf der Startseite: SPA-Fallback auf <code>/index.html</code> und Cache-Header für <code>index.html</code>/<code>sw.js</code> prüfen.</li>
          <li>Worker nicht erreichbar: <code>docker compose logs media-worker</code>, Healthcheck, Access Code und Browser-Cookie prüfen.</li>
          <li>Stream bleibt leer oder startet nicht: Netzwerkfehler, CORS, Statuscode, Range-Requests, Codec und URL-Ablauf kontrollieren.</li>
          <li>Jellyfin-Verbindung klappt, Bilder aber nicht: Jellyfin-Image-URLs und Reverse-Proxy-Zugriff aus dem Browser testen; Bilder und Streams können von unterschiedlichen Hosts kommen.</li>
        </ul>
        <div className="flex flex-wrap gap-3 pt-2"><Link to="/settings?tab=player" className="rounded-xl bg-white/10 px-4 py-2 font-semibold text-white hover:bg-white/15">Player-Einstellungen öffnen</Link><Link to="/settings?tab=servers" className="rounded-xl bg-white/10 px-4 py-2 font-semibold text-white hover:bg-white/15">Server verbinden</Link></div>
      </Section>
    </div>
  )
}
