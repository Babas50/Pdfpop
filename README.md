# PDF Pop v2

Logiciel PDF gratuit qui tourne entièrement dans le navigateur (aucun fichier envoyé sur un serveur). Installable comme application (PWA), PC et mobile.

## Fonctions
- **Annoter** : texte (polices Sans, Serif, Machine ; taille en pt ; gras, italique, barré), surligner (opacité en %, rectangle, arrondi, ellipse, texte du document visible), dessiner (main levée, ligne, flèche, rectangle, ellipse ; épaisseur en pt ; redimensionnable), signer.
- **Assembler** : Fusionner, Diviser (une page par fichier, tous les N pages, par plages), Extraire. Chaque écran a un bouton principal et une phrase qui dit ce qu'il va produire.
- **Alléger** : réduit le poids des PDF pour un envoi par mail, par lot (zip si plusieurs fichiers). Niveaux Léger, Pour un mail, Très léger.

Le remplissage de formulaires n'est plus inclus (utiliser Edge).

## Mise en ligne sur GitHub Pages
1. Créer un dépôt `pdfpop` (public).
2. Décompresser le zip, puis glisser TOUT le contenu (dossiers inclus, et le dossier caché `.github`) dans « Add file > Upload files ». Le total est inférieur à 100 fichiers : un seul glisser-déposer suffit.
3. Commit, puis Settings > Pages > Source : **GitHub Actions**.
4. Le workflow `.github/workflows/pages.yml` publie le site à chaque commit sur `main` (suivi dans l'onglet « Actions »). Il sert les fichiers tels quels, sans passer par Jekyll.
5. L'adresse est `https://VOTRE-NOM.github.io/pdfpop/`.

## Mise à jour
Après toute modification, augmenter `VERSION` dans `sw.js` (ex. `pdfpop-v3`), sinon les anciens fichiers restent en cache.

## Limites
- Pas de modification du texte existant du PDF.
- PDF protégés par mot de passe refusés.
- Emojis et caractères hors police standard remplacés par « ? » à l'export.
- Alléger : recompresse les images JPEG, Flate (dont PNG) et ASCII85 ; CCITT/JBIG2 non touchés. Une signature électronique du PDF d'origine devient invalide. « Très léger » transforme les pages en images (texte non sélectionnable).
