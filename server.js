const express = require('express');
const http = require('http');
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
// Socket.io config for CORS, needed when deploying
const io = new Server(server, {
    cors: {
        origin: "*", 
        methods: ["GET", "POST"]
    }
});

// KONSTANTER
const MAX_TIME_MS = 5000;
const MAX_SCORE = 10;

// SPIL-TILSTAND (STATE)
let games = {}; 
let waitingPlayer = null; 

// Server index.html
app.get('/', (req, res) => {
  res.sendFile(__dirname + '/index.html');
});

// --- SPIL KLASSE (Håndterer al logik for ét rum) ---

class Game {
    constructor(player1Socket, player2Socket) {
        this.id = Math.random().toString(36).substring(2, 9); // Unikt ID
        this.sockets = [player1Socket, player2Socket];
        
        this.players = {
            [player1Socket.id]: { name: "Spiller 1", score: 0, move: null, socket: player1Socket, room: this.id },
            [player2Socket.id]: { name: "Spiller 2", score: 0, move: null, socket: player2Socket, room: this.id }
        };
        this.playerIds = [player1Socket.id, player2Socket.id];
        this.timer = null;
        this.active = true;

        player1Socket.join(this.id);
        player2Socket.join(this.id);
        
        console.log(`Nyt spil oprettet: ${this.id}`);
        this.broadcast('status', `Nyt spil! Din modstander er fundet. Spil ID: ${this.id}`);
        this.broadcastScores();
        this.startTimer();
    }

    broadcast(event, message) {
        io.to(this.id).emit(event, message);
    }

    sendTo(socketId, event, message) {
        io.to(socketId).emit(event, message);
    }
    
    broadcastScores() {
        const scores = {};
        for(const id in this.players) {
            scores[id] = { name: this.players[id].name, score: this.players[id].score, room: this.id };
        }
        this.broadcast('scores', scores);
    }

    startTimer() {
        if (!this.active) return;
        
        if (this.timer) clearTimeout(this.timer);
        
        this.players[this.playerIds[0]].move = null;
        this.players[this.playerIds[1]].move = null;
        
        this.broadcast('status', 'Ny runde startet! Vælg træk inden 5 sekunder.');
        this.broadcastScores(); 
        
        this.timer = setTimeout(() => this.handleTimeout(), MAX_TIME_MS);
    }

    getWinner(p1Move, p2Move) {
        if (p1Move === p2Move) return 0;
        const winningMoves = { 'sten': 'saks', 'saks': 'papir', 'papir': 'sten' };
        if (winningMoves[p1Move] === p2Move) return 1; 
        return 2; 
    }
    
    handleTimeout() {
        if (!this.active) return;
        
        const p1 = this.players[this.playerIds[0]];
        const p2 = this.players[this.playerIds[1]];

        const p1Moved = p1.move !== null;
        const p2Moved = p2.move !== null;
        
        let resultMessage = "";
        
        if (!p1Moved && !p2Moved) {
            resultMessage = "Begge spillere tabte på tid! Uafgjort.";
        } else if (!p1Moved) {
            p2.score++;
            resultMessage = `${p1.name} tabte på tid. Point til ${p2.name}!`;
        } else if (!p2Moved) {
            p1.score++;
            resultMessage = `${p2.name} tabte på tid. Point til ${p1.name}!`;
        } else {
            return;
        }

        this.broadcast('result', resultMessage);
        this.checkGameOver();
        
        if (this.active) {
            setTimeout(() => this.startTimer(), 2000);
        }
    }

    checkResult() {
        const p1 = this.players[this.playerIds[0]];
        const p2 = this.players[this.playerIds[1]];

        if (p1.move && p2.move) {
            clearTimeout(this.timer);
            
            let resultText = "";
            const winner = this.getWinner(p1.move, p2.move);
            
            if (winner === 1) {
                p1.score++;
                resultText = `${p1.name} vandt! (${p1.move} slår ${p2.move})`;
            } else if (winner === 2) {
                p2.score++;
                resultText = `${p2.name} vandt! (${p2.move} slår ${p1.move})`;
            } else {
                resultText = `Uafgjort! Begge valgte ${p1.move}.`;
            }

            this.broadcast('result', `Runde afsluttet: ${resultText}`);
            
            this.checkGameOver();
            
            if (this.active) {
                setTimeout(() => this.startTimer(), 2000); 
            }
        }
    }

    checkGameOver() {
        const p1 = this.players[this.playerIds[0]];
        const p2 = this.players[this.playerIds[1]];
        
        if (p1.score >= MAX_SCORE || p2.score >= MAX_SCORE) {
            const winner = (p1.score >= MAX_SCORE) ? p1 : p2;
            this.active = false;
            
            this.broadcast('game-over', `${winner.name} har vundet spillet med ${MAX_SCORE} point! Genstart siden for at spille et nyt spil.`);
            
            clearTimeout(this.timer);
            delete games[this.id];
        }
    }

    handleMove(socketId, move) {
        if (!this.active || this.players[socketId].move !== null) {
            return;
        }
        this.players[socketId].move = move;
        this.sendTo(socketId, 'status', `Du valgte ${move}. Venter på modstander...`);
        this.checkResult();
    }
    
    handleDisconnect(socketId) {
        const opponentId = this.playerIds.find(id => id !== socketId);
        
        if (opponentId && this.players[opponentId]) {
            this.broadcast('game-over', `${this.players[socketId].name} forlod spillet. Du vinder.`);
            this.active = false;
        }
        
        clearTimeout(this.timer);
        delete games[this.id];
    }
}

// --- SOCKET.IO FORBINDELSE ---

io.on('connection', (socket) => {
    
    if (waitingPlayer) {
        const newGame = new Game(waitingPlayer, socket);
        games[newGame.id] = newGame;
        waitingPlayer = null;
    } else {
        waitingPlayer = socket;
        socket.emit('status', 'Venter på en modstander...');
        socket.emit('scores', null);
    }

    socket.on('make-move', (move) => {
        const gameId = Array.from(socket.rooms)[1];
        if (games[gameId]) {
            games[gameId].handleMove(socket.id, move);
        }
    });

    socket.on('disconnect', () => {
        if (waitingPlayer && waitingPlayer.id === socket.id) {
            waitingPlayer = null;
            return;
        }
        
        const gameId = Array.from(socket.rooms)[1];
        if (games[gameId]) {
            games[gameId].handleDisconnect(socket.id);
        }
    });
});

// Brug den port, Render giver os, ellers brug 3000 lokalt
const port = process.env.PORT || 3000; 

server.listen(port, () => {
  console.log(`Serveren kører på port ${port}`);
});