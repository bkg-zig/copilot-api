# Funktionsspezifikation: Modernes Linux-Server-Admin-WebUI mit integrierter KI-System-Architektur

## Überblick
Dieses Dokument beschreibt die vollständige, hersteller- und paketunabhängige Funktionsspezifikation für ein modernes Linux-Server-Control-Panel. Das Konzept vereint klassische System-, Web-, Mail-, Datenbank- und Container-Administration mit moderner lokaler KI-Infrastruktur sowie einem tief integrierten **KI-System-Helper-Konzept**, bei dem KI-Agenten als eigenständige, streng kontrollierte System-Identitäten mit eigenen Postfächern, Task-Boards und Berechtigungsmatrizen agieren.

---

## Teil 1: Kernfunktionen der Server-Administration

### 1. System- & Betriebssystem-Verwaltung
* **Systeminformationen & Hardware:** Echtzeit-Anzeige von CPU-Kernen, RAM-Belegung, Swap, Festplatten-I/O, Uptime, Kernel-Version und Systemtemperatur.
* **Paket- & Update-Management:** Suche, Installation, Aktualisierung und Entfernung von Betriebssystem-Paketen sowie automatische Sicherheitsupdates.
* **Dienst- & Prozess-Steuerung:** Starten, Stoppen, Neustarten und Autostart-Konfiguration von Hintergrunddiensten; Echtzeit-Prozessliste mit Möglichkeit zum Beenden hängender Prozesse.
* **Aufgabenplaner:** Grafische Verwaltung zeitgesteuerter Aufgaben (Einmalig, Intervall, Neustart-Trigger) inklusive Ausführungs-Logs.
* **Systemprotokolle (Logs):** Zentraler Log-Viewer mit Live-Stream, Suchfunktion, Filterung nach Schweregrad und Export-Möglichkeit.
* **Energie- & Zeitsteuerung:** Geplanter Neustart/Shutdown, Zeitzonen-Einstellung und automatische Uhrzeit-Synchronisation.

### 2. Speicher-, Dateisystem- & Backup-Management
* **Festplatten & Partitionen:** Verwaltung von Datenträgern, Partitionen, Dateisystemen, Einhängepunkten (Mounts) und Software-RAID-Verbünden.
* **Kontingente (Quotas):** Festlegen von Speicherplatz- und Datei-Limits pro Systembenutzer oder Projekt.
* **Web-Dateimanager:** Vollständiger Dateibrowser im WebUI (Erstellen, Hochladen, Herunterladen, Umbenennen, Kopieren, Entpacken/Komprimieren, Text-Editor mit Syntax-Highlighting).
* **Berechtigungen & Besitz:** Grafische Änderung von Lese-, Schreib- und Ausführungsrechten sowie Datei-Eigentümern und -Gruppen.
* **Backup & Wiederherstellung:** Vollständige und inkrementelle Sicherungen (Dateien, Datenbanken, Konfigurationen) auf lokale Datenträger oder externe Netzwerk-Speicher; Wiederherstellung einzelner Elemente oder des Gesamtsystems.

### 3. Netzwerk, Sicherheit & Zugriffsschutz
* **Netzwerkschnittstellen:** Konfiguration von statischen/dynamischen IPv4- und IPv6-Adressen, Subnetzmasken, Gateways, DNS-Resolvern, VLANs und Netzwerkbrücken.
* **Firewall-Verwaltung:** Regelbasierte Steuerung für eingehenden und ausgehenden Datenverkehr (Ports, Protokolle, Quell-/Ziel-IPs, Port-Weiterleitungen).
* **Intrusion Prevention & Zugriffsschutz:** Automatische IP-Sperren bei wiederholten Fehlversuchen (Brute-Force-Schutz), IP-Whitelists/Blacklists und Geo-Blocking.
* **Zertifikats-Management:** Automatische Ausstellung, Einbindung, Verlängerung und Verwaltung von SSL/TLS-Zertifikaten (inklusive Wildcard- und eigenen Zertifikaten).
* **VPN & Tunneling:** Einrichtung und Verwaltung verschlüsselter Netzwerk-Tunnel für den sicheren Fernzugriff auf das System und das Admin-WebUI.
* **Malware- & Schwachstellen-Scan:** Automatisierte Prüfung auf Schadcode, Rootkits, unsichere Dateiberechtigungen und offene Ports.

### 4. Webserver & Anwendungs-Hosting
* **Virtuelle Hosts:** Anlegen, Konfigurieren und Isolieren einzelner Web-Projekte mit eigenen Wurzelverzeichnissen und Systembenutzern.
* **Reverse-Proxy & Load-Balancing:** Weiterleitung von Web-Anfragen an interne Ports, Sockets oder andere Server inklusive Header-Manipulation und Lastverteilung.
* **Laufzeitumgebungen:** Umschalten zwischen verschiedenen Sprach- und Laufzeitversionen pro Projekt sowie Anpassung von Speicher-, Upload- und Timeout-Limits.
* **Caching & Komprimierung:** Steuerung von serverseitigem Seiten-Caching, Browser-Caching und Datenkomprimierung zur Geschwindigkeitsoptimierung.
* **Zugriffsschutz & Weiterleitungen:** HTTP-Weiterleitungen (301/302), Passwortschutz für Verzeichnisse, IP-Beschränkungen und benutzerdefinierte Fehlerseiten.
* **Web Application Firewall (WAF):** Regelbasierte Filterung schädlicher HTTP-Anfragen (z. B. SQL-Injection, Cross-Site-Scripting) auf Webserver-Ebene.

### 5. Domain- & DNS-Verwaltung
* **Zonen-Management:** Anlegen und Verwalten von primären und sekundären DNS-Zonen sowie globalen Vorlagen für neue Domains.
* **Eintrags-Editor:** Vollständige Unterstützung für A-, AAAA-, CNAME-, MX-, TXT-, SRV-, CAA-, PTR- und NS-Einträge.
* **DNS-Sicherheit:** Kryptografische Signierung von DNS-Zonen (DNSSEC) und automatischer Schlüsselwechsel.

### 6. E-Mail-Server-Steuerung
* **Domain- & Postfach-Verwaltung:** Aktivieren von Mail-Funktionen pro Domain, Erstellen von Postfächern mit individuellen Speicherlimits und Passwort-Richtlinien.
* **Routing & Automatisierung:** Einrichten von Weiterleitungen, Aliasen, Catch-All-Adressen, Verteilerlisten und automatischen Abwesenheitsnotizen.
* **Zustellbarkeit & Authentifizierung:** Automatische Generierung und Prüfung von SPF-, DKIM- und DMARC-Einträgen sowie Konfiguration von Reverse-DNS.
* **Spam- & Virenschutz:** Konfigurierbare Filterregeln, Greylisting, Quarantäne-Verwaltung und Echtzeit-Blocklisten (RBL).
* **Mail-Warteschlange (Queue):** Einsicht in feststeckende E-Mails mit Möglichkeit zum erneuten Senden oder Löschen.
* **Webmail-Zugang:** Integrierte Weboberfläche zum Lesen, Schreiben und Organisieren von E-Mails.

### 7. Datenbank-Verwaltung (inkl. Vektor-Daten)
* **Instanzen & Datenbanken:** Erstellen, Löschen, Sichern und Wiederherstellen von relationalen, nicht-relationalen und **Vektor-Datenbanken** (für KI-Embeddings).
* **Benutzer- & Rechteverwaltung:** Anlegen von Datenbank-Benutzern mit feingranularen Berechtigungen und Host-Beschränkungen.
* **Web-Datenbank-Editor:** Browserbasierte Oberfläche zum Ausführen von Abfragen, Bearbeiten von Tabellen, Verwalten von Vektor-Indizes sowie Importieren und Exportieren von Datenbeständen.

### 8. Container, Virtualisierung & Entwickler-Workflows
* **Container-Management:** Erstellen, Starten, Stoppen, Aktualisieren und Überwachen isolierter Software-Container inklusive Verwaltung von Images, Netzwerken und Volumes.
* **Hintergrund-Worker & Dienste:** Verwaltung dauerhaft laufender Anwendungsprozesse (z. B. für Web-Apps, Queues oder Bots) mit automatischem Neustart bei Abstürzen.
* **Code-Deployment:** Automatisierte Bereitstellung von Quellcode aus Versionsverwaltungssystemen per Webhook oder Knopfdruck inklusive Build-Skripten.
* **Web-Terminal:** Vollwertige Kommandozeile (Shell) direkt im Browser für direkte Systemeingriffe.
* **Dateiübertragungs-Zugänge:** Verwaltung von verschlüsselten Dateiübertragungs-Konten (z. B. SFTP/FTPS) mit Verzeichnis-Isolierung (Chroot).

---

## Teil 2: KI-Infrastruktur & KI-Server-Assistent

### 9. KI-Infrastruktur & Modell-Hosting
* **GPU- & Hardware-Beschleuniger-Monitoring:** Echtzeit-Überwachung von Grafikprozessoren (VRAM-Auslastung, GPU-Last, Temperatur, Taktfrequenz, Stromverbrauch) sowie Zuweisung einzelner GPUs an spezifische Container oder Dienste.
* **Lokale KI-Modell-Verwaltung:** Herunterladen, Aktualisieren, Quantisieren und Löschen von Sprach-, Bild- und Audio-Modellen direkt über das WebUI inklusive Speicherplatz-Übersicht.
* **Inferenz-Server-Steuerung:** Starten, Skalieren und Konfigurieren lokaler KI-Endpunkte (Kontextlänge, Batch-Größe, GPU-Layer-Offloading, parallele Anfragen).
* **Zentrales KI-API-Gateway:** Bereitstellung einer einheitlichen lokalen oder abgesicherten API-Schnittstelle für gehostete Web-Apps – inklusive API-Key-Generierung, Rate-Limiting und Token-Verbrauchsmessung pro Projekt.
* **Wissensdatenbank- & RAG-Pipelines:** Verwaltung von Dokumenten-Verzeichnissen, die automatisch zerlegt, vektorisiert und für eigene KI-Anwendungen durchsuchbar gemacht werden.
* **KI-Agenten- & Workflow-Runner:** Isolierte Laufzeitumgebung zum Hosten und Überwachen autonomer KI-Agenten, Hintergrund-Worker und Automatisierungs-Pipelines inklusive Ausführungshistorie.

### 10. Intelligenter KI-Server-Assistent / Copilot
* **Log-Analyse & Ursachenforschung (Root-Cause-Analysis):** KI-gestütztes Auslesen kryptischer System-, Webserver- und Mail-Logs mit verständlicher Fehlererklärung und direkten Lösungsvorschlägen per Klick.
* **Konfigurations-Generator & Validator:** Erstellen und Prüfen von komplexen Webserver-Regeln, Firewall-Richtlinien, DNS-Zonen oder Aufgabenplänen per natürlicher Sprache.
* **Terminal-Copilot:** Übersetzung von menschlichen Anweisungen in sichere Linux-Shell-Befehle direkt im Web-Terminal – inklusive Warnhinweis vor destruktiven Befehlen und Bestätigungszwang vor der Ausführung.
* **Prädiktive Anomalie- & Sicherheitsanalyse:** Automatische Erkennung ungewöhnlicher Lastspitzen, verdächtiger Login-Muster oder potenzieller Sicherheitslücken in Berechtigungen und offenen Ports.
* **Selbstheilungs-Automatismen (Auto-Remediation):** Definierbare KI-gestützte Reaktionsregeln (z. B. automatisches Bereinigen von temporären Dateien bei vollem Speicher oder Neustart hängender Dienste nach Diagnose).
* **Datenschutz- & Modellwahl:** Umschaltbarkeit zwischen **100 % lokalem Offline-KI-Modell** (volle Datensouveränität auf dem eigenen Server) und externen KI-Schnittstellen mit automatischer Maskierung sensibler Daten (Passwörter, Keys, IPs).

---

## Teil 3: Das KI-System-Helper-Konzept & 3-Säulen-Rollensystem

### 11. Das 3-Säulen-Rollensystem (Admin, User & KI-Entitäten)
Das Berechtigungskonzept behandelt Menschen und KI-Agenten nach demselben Sicherheitsprinzip (**Least Privilege**), trennt sie aber technisch sauber:

| Identitäts-Typ | Rolle & Verantwortung | System-Zugriff & Grenzen |
| :--- | :--- | :--- |
| **Super-Admin (Mensch)** | Vollzugriff auf Hardware, Kernel, Netzwerk, alle Mandanten und globale KI-Policies. | Darf globale Token-Budgets setzen, KI-Modelle freigeben, KI-Identitäten erschaffen und Notfall-Abschaltungen (Kill-Switch) auslösen. |
| **Projekt-User / Mandant (Mensch)** | Verwaltet eigene Domains, Webseiten, Datenbanken und Postfächer innerhalb seines Pakets. | Darf ihm zugewiesene KI-Helper in seinen Projekten nutzen, eigene Projekt-KI-Helper anlegen (im Rahmen seines Kontingents) und deren Aufgaben einsehen. |
| **KI-System-Helper (Global)** | Der „digitale Co-Admin“ des gesamten Servers. Überwacht Systemzustand, Logs, Backups und Updates. | Hat Leserechte auf Systemmetriken; Schreibrechte (z. B. Dienst-Neustart, IP-Sperre) sind über Freigabe-Stufen (Autonom vs. Bestätigungspflicht) geregelt. |
| **KI-Projekt-Helper (Zugeordnet)** | Spezialisierter Assistent für ein einzelnes Projekt oder einen Kunden (z. B. *Web-Support-Bot* oder *Deploy-Agent*). | **Strikte Isolation (Sandbox):** Sieht ausschließlich die Dateien, Datenbanken, Logs und Mails des zugewiesenen Projekts. Keinerlei Zugriff auf das Host-System. |

### 12. Die „KI-Identität“: Ausstattung jedes KI-Helpers
Jede angelegte KI-Instanz existiert als eigenständiges Objekt im System mit folgenden Modulen:

* **Eigene System-E-Mail-Adresse:** Jede KI erhält ein echtes Postfach (z. B. `sys-helper@server.local` oder `projekt-a-bot@kunde.de`).
  * *Eingehend:* Kann Support-Anfragen, Fehlerberichte oder Anweisungen per E-Mail empfangen, lesen und im Kontext des Projekts verarbeiten.
  * *Ausgehend:* Verschickt Statusberichte, Warnmeldungen, Backup-Zusammenfassungen oder Antworten – begrenzt durch ein Rate-Limit (z. B. max. 20 Mails/Stunde gegen Spam-Schleifen).
* **Eigenes Task- & Ticket-Board:** Eine sichtbare Aufgabenliste pro KI-Helper.
  * Tasks entstehen durch Zeitpläne (Cron), System-Events (z. B. *Festplatte > 85 %*), eingehende E-Mails oder direkte Zuweisung durch User/Admins.
  * Status-Tracking: `Offen` -> `In Bearbeitung` -> `Wartet auf Menschen-Freigabe` -> `Erledigt / Fehlgeschlagen`.
* **Dediziertes KI-Dashboard (Aktivitäts-Zentrale):**
  * **Live-Status:** Echtzeit-Anzeige, was die KI gerade prüft oder bearbeitet.
  * **Entscheidungs-Log (Reasoning-Protokoll):** Nachvollziehbare Erklärung, *warum* die KI eine bestimmte Aktion vorgeschlagen oder ausgeführt hat.
  * **Freigabe-Warteschlange (Human-in-the-Loop):** Kritische Aktionen (z. B. Datenbank-Migration, Firewall-Regel ändern, Mail nach außen senden) pausieren hier, bis ein berechtigter Mensch auf „Genehmigen“ klickt.
  * **Verbrauchs-Statistik:** Live-Balken für verbrauchte Tokens, API-Kosten, Rechenzeit und ausgeführte Aktionen.

### 13. Projekt-Zuordnung & Feingranulare Begrenzungen (Guardrails)
Wenn ein Admin oder Projekt-User einen KI-Helper einem Projekt (oder dem Gesamtsystem) zuordnet, greift ein **5-stufiges Regelwerk**:

1. **Token- & Budget-Limits:**
   * Maximale Input- und Output-Tokens pro Stunde, Tag und Monat.
   * Hartes Kosten- oder Rechenzeit-Limit (bei Erreichen wechselt die KI automatisch in den „Pausiert“-Modus und benachrichtigt den Besitzer).
   * Begrenzung der maximalen Kontextlänge und Denkschritte (Loop-Schutz gegen Endlosschleifen).
2. **Modell-Whitelist & Routing:**
   * Festlegung, welche Sprach-, Code- oder Vision-Modelle diese KI nutzen darf (z. B. *Nur lokales kleines Modell für Routine-Logs, großes Modell nur bei kritischen Fehlern*).
   * Strikte Trennung zwischen **100 % lokalen Offline-Modellen** (für sensible Projektdaten) und externen Cloud-Modellen.
3. **Dienst- & Werkzeug-Matrix (Tool-Permissions):**
   * Exakte Checkbox-Freigabe, welche Server-Module die KI in diesem Projekt überhaupt sehen und steuern darf:
     * *Dateisystem:* Kein Zugriff / Nur Lesen / Lesen & Schreiben (nur im Projekt-Ordner).
     * *Datenbanken:* Kein Zugriff / Nur lesende Abfragen (`SELECT`) / Volle Struktur- & Datenrechte.
     * *Webserver & Domains:* Konfiguration lesen / Cache leeren / Virtuelle Hosts bearbeiten.
     * *E-Mail:* Nur eigenes KI-Postfach / Postfächer des Projekts verwalten.
     * *Container & Dienste:* Status lesen / Neustart erlauben / Container erstellen & löschen.
     * *Terminal / Shell:* Komplett gesperrt / Nur vordefinierte sichere Befehle / Freie Shell (nur für globale System-KI mit Freigabezwang).
4. **Autonomie-Stufe (Freigabe-Policy):**
   * **Stufe 1 – Beobachter (Read-Only):** Darf nur analysieren, Tasks anlegen und Berichte per Mail senden.
   * **Stufe 2 – Assistent (Approve-Mode):** Bereitet Änderungen vor (z. B. Config-Diff, SQL-Befehl, Mail-Entwurf), Ausführung erst nach Klick durch User/Admin.
   * **Stufe 3 – Teil-Autonom:** Darf harmlose Routine-Aktionen selbstständig ausführen (z. B. Cache leeren, Dienst neu starten), fragt aber bei destruktiven Aktionen (Löschen, Überschreiben) nach.
5. **Zeit- & Trigger-Fenster:**
   * Festlegung, wann die KI aktiv sein darf (z. B. Wartungsfenster nachts zwischen 02:00 und 04:00 Uhr) und wie oft sie pro Minute durch Events geweckt werden darf.

### 14. Benutzer-, Rollen- & Mandantenverwaltung sowie Monitoring & API
* **System- & Panel-Benutzer:** Trennung zwischen Super-Administratoren, eingeschränkten Administratoren, Wiederverkäufern und Endnutzern.
* **Feingranulare Berechtigungen (RBAC):** Exakte Zuweisung, welcher Benutzer welche Module, GPUs, KI-Helper oder KI-Modelle sehen und nutzen darf.
* **Hosting-Pakete & Ressourcen-Limits:** Bündelung von Grenzwerten (CPU-Kerne, RAM, GPU-Anteile, Speicherplatz, Domains, Datenbanken, Postfächer, Token-Kontingente) in zuweisbare Tarife.
* **Benutzer-Impersonation:** Möglichkeit für Administratoren, sich ohne Passwort in die Ansicht eines untergeordneten Benutzers einzuloggen (für Support-Zwecke).
* **Historische Metriken & Alarmierung:** Langzeit-Diagramme für Systemlast, GPU-Auslastung und Dienst-Verfügbarkeit sowie automatische Benachrichtigungen (E-Mail, Webhook, Messenger) bei Schwellenwert-Überschreitungen.
* **Audit-Log & Admin-Sicherheit:** Lückenlose Protokollierung aller menschlichen und KI-gesteuerten Aktionen, Erzwingung von Zwei-Faktor-Authentifizierung (2FA), Sitzungsverwaltung und IP-Beschränkung für den Login.
* **REST-API & CLI:** Vollständige Programmierschnittstelle und eigenes Kommandozeilen-Werkzeug, um alle Funktionen des WebUIs auch automatisiert von außen zu steuern.

---

## Teil 4: Modul-Übersicht der Gesamtarchitektur

* **Modul A – Kern-Infrastruktur:** Hardware- & OS-Monitoring, Paket-Updates, Dienst-Steuerung, Aufgabenplaner, Zentraler Log-Viewer.
* **Modul B – Speicher & Backups:** Festplatten/RAID, Quotas, Web-Dateimanager, Rechteverwaltung, Inkrementelle Backups & Wiederherstellung.
* **Modul C – Netzwerk & Sicherheit:** Netzwerkschnittstellen, Firewall, Brute-Force-Schutz, SSL/TLS-Zertifikate, VPN-Tunnel, Malware-Scanner.
* **Modul D – Web, DNS & Mail:** Virtuelle Hosts, Reverse-Proxy, WAF, DNS-Zonen & DNSSEC, Mail-Server (Postfächer, SPF/DKIM/DMARC, Spamfilter, Webmail).
* **Modul E – Daten & Container:** Relationale & Vektor-Datenbanken, Web-DB-Editor, Container-Engine, Git-Deployment, SFTP, Web-Terminal.
* **Modul F – KI-Rechenzentrum:** GPU/VRAM-Verwaltung, Lokale Modell-Bibliothek, Inferenz-Endpunkte, Zentrales API-Gateway, RAG-Wissensdatenbanken.
* **Modul G – KI-Helper & Agenten-Zentrale:** Verwaltung aller KI-Identitäten, eigene KI-Postfächer, Task-Boards, Freigabe-Warteschlange, Modell-Whitelists & Token-Limits.
* **Modul H – Identitäten, Rollen & Audit:** Mandanten- & Paketverwaltung, RBAC-Rechtematrix für Menschen & KIs, 2FA, lückenloses Audit-Log, REST-API & CLI.
