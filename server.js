const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
    cors: {
        origin: "*"
    }
});

app.use(express.static(path.join(__dirname, "public")));

const lobbies = {};

function generateCode() {
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

    let code = "";

    for (let i = 0; i < 6; i++) {
        code += chars[Math.floor(Math.random() * chars.length)];
    }

    return code;
}

function getLobby(code) {
    return lobbies[code];
}

function shuffle(array) {
    for (let i = array.length - 1; i > 0; i--) {

        const j = Math.floor(Math.random() * (i + 1));

        [array[i], array[j]] = [array[j], array[i]];
    }

    return array;
}

function assignTeams(lobby) {

    const players = [...lobby.players];

    shuffle(players);

    lobby.teams = {
        north: [],
        south: []
    };

    players.forEach((player, index) => {

        if (index % 2 === 0) {
            lobby.teams.north.push(player.id);
            player.team = "north";
        } else {
            lobby.teams.south.push(player.id);
            player.team = "south";
        }
    });
}

function startGame(lobby) {

    assignTeams(lobby);

    lobby.game = {
        round: 1,
        maxRounds: 20,
        phase: "smuggler",

        northATM: 300,
        southATM: 300,

        northBank: 100,
        southBank: 100,

        suitcase: 0,

        smuggler: null,
        customs: null,

        doubt: 0
    };

    chooseRoles(lobby);
}

function chooseRoles(lobby) {

    const northPlayers = lobby.players.filter(
        p => p.team === "north"
    );

    const southPlayers = lobby.players.filter(
        p => p.team === "south"
    );

    if (
        northPlayers.length === 0 ||
        southPlayers.length === 0
    ) {
        return;
    }

    const smuggler =
        northPlayers[
            Math.floor(Math.random() * northPlayers.length)
        ];

    const customs =
        southPlayers[
            Math.floor(Math.random() * southPlayers.length)
        ];

    lobby.game.smuggler = smuggler.id;
    lobby.game.customs = customs.id;

    lobby.game.suitcase = 0;
    lobby.game.doubt = 0;
    lobby.game.phase = "smuggler";

    emitLobbyState(lobby);
}

function emitLobbyState(lobby) {

    const publicState = {
        code: lobby.code,
        players: lobby.players.map(p => ({
            id: p.id,
            name: p.name,
            team: p.team
        })),
        game: lobby.game
    };

    io.to(lobby.code).emit(
        "lobbyState",
        publicState
    );
}

io.on("connection", socket => {

    console.log("Connecté :", socket.id);

    socket.on("createLobby", ({ name }) => {

        let code;

        do {
            code = generateCode();
        } while (lobbies[code]);

        const lobby = {
            code,
            host: socket.id,
            players: []
        };

        const player = {
            id: socket.id,
            name,
            team: null
        };

        lobby.players.push(player);

        lobbies[code] = lobby;

        socket.join(code);

        socket.emit("lobbyCreated", {
            code
        });

        emitLobbyState(lobby);
    });

    socket.on("joinLobby", ({ code, name }) => {

        code = code.toUpperCase();

        const lobby = getLobby(code);

        if (!lobby) {
            socket.emit(
                "errorMessage",
                "Lobby introuvable"
            );
            return;
        }

        const player = {
            id: socket.id,
            name,
            team: null
        };

        lobby.players.push(player);

        socket.join(code);

        emitLobbyState(lobby);
    });

    socket.on("startGame", ({ code }) => {

        const lobby = getLobby(code);

        if (!lobby) return;

        if (socket.id !== lobby.host) return;

        startGame(lobby);

        emitLobbyState(lobby);
    });

    socket.on("putMoney", ({ code, amount }) => {

        const lobby = getLobby(code);

        if (!lobby) return;

        if (
            socket.id !== lobby.game.smuggler
        ) return;

        amount = Number(amount);

        if (
            isNaN(amount) ||
            amount < 0 ||
            amount > 100
        ) {
            return;
        }

        lobby.game.suitcase = amount;
        lobby.game.phase = "customs";

        emitLobbyState(lobby);
    });

    socket.on("customsPass", ({ code }) => {

        const lobby = getLobby(code);

        if (!lobby) return;

        if (
            socket.id !== lobby.game.customs
        ) return;

        const amount = lobby.game.suitcase;

        lobby.game.northATM -= amount;
        lobby.game.northBank += amount;

        nextRound(lobby);
    });

    socket.on(
        "customsDoubt",
        ({ code, amount }) => {

            const lobby = getLobby(code);

            if (!lobby) return;

            if (
                socket.id !== lobby.game.customs
            ) return;

            amount = Number(amount);

            const suitcase =
                lobby.game.suitcase;

            if (amount >= suitcase) {

                lobby.game.southBank +=
                    suitcase;

            } else {

                lobby.game.northBank +=
                    suitcase;

                lobby.game.northBank +=
                    Math.floor(
                        (suitcase - amount) / 2
                    );
            }

            nextRound(lobby);
        }
    );

    socket.on("disconnect", () => {

        Object.values(lobbies).forEach(
            lobby => {

                lobby.players =
                    lobby.players.filter(
                        p => p.id !== socket.id
                    );

                if (
                    lobby.players.length === 0
                ) {
                    delete lobbies[lobby.code];
                } else {
                    emitLobbyState(lobby);
                }
            }
        );

        console.log(
            "Déconnecté :",
            socket.id
        );
    });
});

function nextRound(lobby) {

    lobby.game.round++;

    if (
        lobby.game.round >
        lobby.game.maxRounds
    ) {

        lobby.game.phase = "finished";

        emitLobbyState(lobby);

        return;
    }

    chooseRoles(lobby);
}

const PORT =
    process.env.PORT || 3000;

server.listen(PORT, () => {

    console.log(
        "Serveur lancé sur le port",
        PORT
    );
});
