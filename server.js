const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// servir les fichiers statiques (ici juste index.html)
app.use(express.static(path.join(__dirname)));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Serveur Contraband lancé sur le port ${PORT}`);
});
