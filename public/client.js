const socket = io();

let myLobby = null;
let myRole = null;
let popupTimer = null;

// =====================
// UTILITAIRES
// =====================

function show(id){

```
const el = document.getElementById(id);

if(el){
    el.classList.remove("hidden");
}
```

}

function hide(id){

```
const el = document.getElementById(id);

if(el){
    el.classList.add("hidden");
}
```

}

function popup(text,color="#ffd700"){

```
const box =
document.getElementById("popup");

if(!box) return;

clearTimeout(popupTimer);

box.textContent = text;
box.style.color = color;
box.style.display = "block";

popupTimer = setTimeout(()=>{
    box.style.display = "none";
},3000);
```

}

// =====================
// LOBBY
// =====================

function createLobby(){

```
const name =
document.getElementById("playerName")
.value
.trim();

if(name.length < 2){

    popup(
        "Pseudo trop court",
        "#ff4444"
    );

    return;
}

socket.emit(
    "createLobby",
    {
        name
    }
);
```

}

function joinLobby(){

```
const name =
document.getElementById("playerName")
.value
.trim();

const code =
document.getElementById("joinCode")
.value
.trim()
.toUpperCase();

if(!name || !code){

    popup(
        "Informations manquantes",
        "#ff4444"
    );

    return;
}

socket.emit(
    "joinLobby",
    {
        name,
        code
    }
);
```

}

// =====================
// SOCKET EVENTS
// =====================

socket.on(
"connect",
()=>{
console.log(
"Connecté :",
socket.id
);
}
);

socket.on(
"disconnect",
()=>{
popup(
"Connexion perdue",
"#ff4444"
);
}
);

socket.on(
"lobbyCreated",
data=>{

```
myLobby = data.code;

hide("lobbyScreen");
show("waitingScreen");

document
.getElementById("lobbyCode")
.textContent =
data.code;

popup(
    "Lobby créé : " +
    data.code,
    "#4cff75"
);
```

}
);

socket.on(
"lobbyState",
state=>{

```
if(!state) return;

if(!myLobby){

    myLobby =
    state.code;

    hide("lobbyScreen");
    show("waitingScreen");

    const codeBox =
    document.getElementById(
        "lobbyCode"
    );

    if(codeBox){
        codeBox.textContent =
        state.code;
    }
}

updatePlayers(
    state.players || []
);

if(state.game){

    updateGame(state);
}
```

}
);

socket.on(
"errorMessage",
msg=>{

```
popup(
    "❌ " + msg,
    "#ff4444"
);
```

}
);
