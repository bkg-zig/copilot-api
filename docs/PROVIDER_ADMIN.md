# Provider- und Modellverwaltung

## Öffnen und Authentifizierung

Das Dashboard liegt unter:

https://copi.eysho.info/usage-viewer

Dort den Tab **Admin** öffnen. Die lokale Admin-API verwendet dieselbe serverseitige Copi-Websitzung wie das Dashboard. Es gibt keinen separaten Admin-API-Key im Browser. Die Sitzung liegt in einem HttpOnly-Cookie; Provider-Schlüssel werden ausschließlich serverseitig gespeichert.

## Provider hinzufügen

Im linken Bereich **Add provider** ausfüllen:

- Provider-ID: kleingeschrieben, zum Beispiel my-provider.
- Protocol: OpenAI-compatible, OpenAI Responses, Anthropic Messages oder Google GenerateContent.
- Base URL: API-Basisadresse ohne Zugangsdaten in der URL. Explizite Pfade wie /v1, /v1beta/openai, /openai und /api/gateway werden passend zum Provider-Protokoll verwendet.
- Authentication: None für einen tatsächlich öffentlich erreichbaren API-Endpunkt ohne Upstream-Authentifizierung; sonst Bearer, x-api-key, x-goog-api-key oder Azure Entra.
- API key: nur erforderlich, wenn der Upstream ihn verlangt. Bei None bleibt das Feld leer.

None bedeutet ausdrücklich nur, dass Copi keinen Authentifizierungsheader zum Upstream sendet. Es deaktiviert weder die Copi-Websitzung noch die Authentifizierung gegenüber der lokalen Admin-API.

## Free-API-Katalog

**Load catalogue** lädt die gepflegte Liste von mvalentsev/awesome-free-ai-coding serverseitig. Copi zeigt nur nicht archivierte, nicht vorläufige Einträge mit als OpenAI-kompatibel markierter API an.

**Use in form** übernimmt ID, API-Basisadresse und Authentifizierungsart in das Provider-Formular. Erfordert der Upstream einen API-Key, muss dieser vor dem Speichern ergänzt werden. Tarif, Registrierung/Kartenpflicht, Region, Datenverwendung und aktuelle Limits sind vor der Aktivierung direkt beim Anbieter zu prüfen. Ein Katalogeintrag ist keine Verfügbarkeits- oder Nutzungszusage.

## Modelle verwalten

**Discover and test** liest den Modellkatalog des Providers und prüft Modell-IDs mit echten Completion-Requests. Nur eine erfolgreiche Antwort mit nicht-leerem Text gilt als gesund.

- **Healthy**: Completion erfolgreich.
- **Failed**: Request fehlgeschlagen, HTTP-Fehler oder leere/unvollständige Completion.
- **Not tested**: noch kein Health-Ergebnis vorhanden.

Für jeden Provider einschließlich des systemverwalteten bkg-api kann eine Modell-ID manuell ergänzt werden. Sie wird vor dem Speichern getestet. Einzelne Modelle können deaktiviert oder wieder freigegeben werden.

## Systemverwalteter Provider

bkg-api ist an /srv/bkg/core/api/api_global/ gebunden. Upstream-URL und Schlüssel bleiben systemverwaltet. Im Admin-Bereich können Modelle entdeckt, geprüft, ergänzt und einzeln deaktiviert werden.

## Sicherheit und Persistenz

- Provider-Schlüssel werden serverseitig in der geschützten Gateway-Konfiguration gespeichert.
- Provider-Schlüssel erscheinen in keiner Admin-GET-Antwort und werden nicht im Frontend gespeichert.
- Die lokale Admin-API akzeptiert die Copi-Websitzung; normale API-Client-Schlüssel sind kein Ersatz für diese Sitzung.
- Externe Upstream-Schlüssel werden nur bei Providern verlangt, die sie tatsächlich benötigen.
- Benutzerdefinierte Provider und Modellfreigaben bleiben bei einem Container-Neustart erhalten.
