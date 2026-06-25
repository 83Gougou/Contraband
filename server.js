
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static("public"));

const lobbies = {};

function codeGen() {
  return Math.random().toString(36).substring(2,6).toUpperCase();
}

function shuffle(a){
  for(let i=a.length-1;i>0;i--){
    const j=Math.floor(Math.random()*(i+1));
    [a[i],a[j]]=[a[j],a[i]];
  }
}

function safeNumber(n){
  n = Number(n);
  if(isNaN(n)) return 0;
  return Math.max(0, Math.min(100, n));
}

io.on("connection",(socket)=>{

  socket.on("create",(name,cb)=>{
    const code = codeGen();
    lobbies[code]={
      players:[{id:socket.id,name}],
      game:null
    };
    socket.join(code);
    cb(code);
  });

  socket.on("join",(code,name,cb)=>{
    const l = lobbies[code];
    if(!l) return cb(false);

    l.players.push({id:socket.id,name});
    socket.join(code);
    io.to(code).emit("players",l.players);
    cb(true);
  });

  socket.on("start",(code)=>{
    const l = lobbies[code];
    if(!l || l.players.length<2) return;

    const p=[...l.players];
    shuffle(p);

    l.game={
      phase:"smuggler",
      smuggler:p[0].id,
      customs:p[1].id,
      suitcase:0,
      declared:0,
      history:[]
    };

    io.to(code).emit("state", publicState(l, socket.id));
  });

  socket.on("put",(code,val)=>{
    const l=lobbies[code];
    if(!l || !l.game) return;
    if(socket.id!==l.game.smuggler) return;
    if(l.game.phase!=="smuggler") return;

    val=safeNumber(val);
    l.game.suitcase=val;
    l.game.phase="declare";

    io.to(code).emit("state", publicState(l));
  });

  socket.on("declare",(code,val)=>{
    const l=lobbies[code];
    if(!l||!l.game) return;
    if(socket.id!==l.game.smuggler) return;
    if(l.game.phase!=="declare") return;

    val=safeNumber(val);
    l.game.declared=val;
    l.game.phase="customs";

    io.to(code).emit("state", publicState(l));
  });

  socket.on("choice",(code,doubt)=>{
    const l=lobbies[code];
    if(!l||!l.game) return;
    if(socket.id!==l.game.customs) return;
    if(l.game.phase!=="customs") return;

    const real=l.game.suitcase;
    const dec=l.game.declared;

    let result;
    if(doubt){
      result = (real===dec) ? "customsLose" : "customsWin";
    }else{
      result = "smugglerWin";
    }

    l.game.history.push({real,dec,result});
    l.game.phase="result";
    l.game.result=result;

    io.to(code).emit("state", publicState(l));

    setTimeout(()=>{
      nextRound(l,code);
    },3000);
  });

  socket.on("disconnect",()=>{
    for(const code in lobbies){
      const l=lobbies[code];
      l.players=l.players.filter(p=>p.id!==socket.id);
    }
  });

});

function nextRound(l,code){
  const ids = l.players.map(p=>p.id);
  shuffle(ids);

  l.game={
    phase:"smuggler",
    smuggler:ids[0],
    customs:ids[1],
    suitcase:0,
    declared:0,
    history:l.game.history
  };

  io.to(code).emit("state", publicState(l));
}

function publicState(l){
  return {
    players:l.players,
    game:{
      phase:l.game.phase,
      smuggler:l.game.smuggler,
      customs:l.game.customs,
      declared:l.game.declared,
      history:l.game.history,
      result:l.game.result
    }
  };
}

server.listen(3000,()=>console.log("running"));
