# Opgavestyring

Hjemmeside til at holde styr på opgaver i dine boliger (hus, lejlighed, sommerhus …), sorteret efter rum, med billeder og login.

Lavet i almindelig HTML, CSS og JavaScript med en lille PHP-fil (`api.php`) til login og lagring, så den kan køre på et almindeligt webhotel som Simply.com.

| Fil | Indhold |
| --- | --- |
| `index.html` | Selve siden |
| `style.css` | Udseende |
| `app.js` | Funktionerne i siden |
| `api.php` | Login, database og billeder |
| `.htaccess`, `.user.ini` | Indstillinger til webhotellet |

## Læg siden op på Simply.com

1. **GitHub → Simply automatisk:** I repositoriet på GitHub går du til
   *Settings → Secrets and variables → Actions → New repository secret* og opretter:
   - `FTP_USERNAME` – dit FTP-brugernavn fra Simply (står i kontrolpanelet under FTP)
   - `FTP_PASSWORD` – din FTP-adgangskode

   Gå derefter til fanen *Actions*, vælg **Deploy til Simply** og tryk *Run workflow*.
   Fremover bliver siden opdateret automatisk, hver gang der pushes til `main`.

2. **Installation:** Åbn dit domæne i browseren (fx `https://ditdomæne.dk`). Du ser en installationsside:
   - Vælg **SQLite** (nemmest) – eller **MySQL**, hvis du hellere vil bruge en database fra Simply's kontrolpanel.
   - Opret din egen bruger.

   Gør det med det samme efter upload, da den første, der åbner siden, opretter administratoren.

3. Opret flere brugere under **Brugere** – kun de kan logge ind.

## Data og backup

Databasen og billederne ligger i mappen `data/` på webhotellet, og databaseopsætningen i `config.php`.
Ingen af dem kommer på GitHub, og upload fra GitHub rører dem ikke.
Tag en kopi af `data/` og `config.php` via Simply's filhåndtering som backup.

Hvis upload fejler med en TLS/SSL-fejl, så ret `protocol: ftps` til `protocol: ftp` i `.github/workflows/deploy.yml`.

## Kør lokalt

Kræver PHP 8.1+ med `pdo_sqlite`:

```
php -S localhost:8080
```
