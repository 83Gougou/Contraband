const socket = io();

let myLobby = null;
let myRole = null;



// =====================
// UTILITAIRES
// =====================


function show(id){

    document
    .getElementById(id)
    .classList
    .remove("hidden");

}



function hide(id){

    document
    .getElementById(id)
    .classList
    .add("hidden");

}



function popup(text,color="#ffd700"){

    const box =
    document.getElementById("popup");


    box.innerHTML=text;

    box.style.display="block";

    box.style.color=color;


    setTimeout(()=>{

        box.style.display="none";

    },3000);

}





// =====================
// LOBBY
// =====================



function createLobby(){

    const name =
    document.getElementById("playerName").value;


    if(!name){

        popup("Entre un pseudo !");
        return;

    }


    socket.emit(
        "createLobby",
        {
            name
        }
    );

}




function joinLobby(){

    const name =
    document.getElementById("playerName").value;


    const code =
    document.getElementById("joinCode").value;



    if(!name || !code){

        popup("Informations manquantes");
        return;

    }



    socket.emit(
        "joinLobby",
        {
            name,
            code
        }
    );

}




socket.on(
"lobbyCreated",
data=>{


    myLobby=data.code;


    popup(
    "Lobby créé : "+data.code
    );


    hide("lobbyScreen");

    show("waitingScreen");


    document
    .getElementById("lobbyCode")
    .innerText=data.code;


});






// =====================
// ETAT DU JEU
// =====================



socket.on(
"lobbyState",
state=>{


    if(!myLobby){

        myLobby=state.code;

    }



    if(state.game){

        updateGame(state);

    }



    updatePlayers(state.players);



});





function updatePlayers(players){


    const list =
    document.getElementById("playersList");


    if(!list) return;


    list.innerHTML="";


    players.forEach(p=>{


        let div =
        document.createElement("div");


        div.className="player";


        div.innerHTML=

        `
        👤 ${p.name}
        ${p.team ?
        (p.team==="north"?
        " 🔵":" 🔴")
        :
        ""}
        `;


        list.appendChild(div);



    });



}





// =====================
// START GAME
// =====================



function startGame(){


    socket.emit(
        "startGame",
        {
            code:myLobby
        }
    );


}






// =====================
// JEU
// =====================



function updateGame(state){


    hide("waitingScreen");

    show("gameScreen");



    const game =
    state.game;



    document
    .getElementById("round")
    .innerHTML=

    `
    🎲 Manche ${game.round}/${game.maxRounds}
    `;




    // trouver mon rôle


    if(game.smuggler===socket.id){

        myRole="smuggler";

    }


    else if(game.customs===socket.id){

        myRole="customs";

    }


    else{

        myRole="spectator";

    }





    const roleBox =
    document.getElementById("role");



    if(myRole==="smuggler"){


        roleBox.innerHTML=
        `
        🕵️ TU ES LE PASSEUR
        <br>
        Cache ton argent dans la valise
        `;


        showSmuggler();



    }



    else if(myRole==="customs"){



        roleBox.innerHTML=

        `
        🚨 TU ES LE DOUANIER

        <br>

        Trouve la fraude
        `;



        showCustoms();



    }



    else{


        roleBox.innerHTML=
        `
        👀 Spectateur
        `;


    }





    document
    .getElementById("caseMoney")
    .innerHTML=

    game.suitcase+" 💵";



}







// =====================
// PASSEUR
// =====================



function showSmuggler(){



const box =
document.getElementById("actions");



box.innerHTML=

`

<h2>
💼 Choisir contenu valise
</h2>


<input 
id="moneyInput"
type="number"
placeholder="0-100">


<button onclick="sendMoney()">

🚶 Passer la frontière

</button>

`;



}





function sendMoney(){


const amount =
Number(
document.getElementById("moneyInput").value
);



socket.emit(
"putMoney",
{

code:myLobby,

amount

}
);


popup(
"💼 Valise préparée..."
);



}






// =====================
// DOUANIER
// =====================



function showCustoms(){


const box =
document.getElementById("actions");



box.innerHTML=

`

<h2>
🚨 Contrôle
</h2>


<button onclick="customPass()">

✅ PASSER

</button>



<input
id="doubtInput"
type="number"
placeholder="Montant suspect">


<button onclick="customDoubt()">

🚨 DOUTER

</button>

`;



}





function customPass(){


socket.emit(

"customsPass",

{
code:myLobby
}

);



popup(
"✅ Passage accepté",
"#4cff75"
);


}






function customDoubt(){


const amount=

Number(
document.getElementById("doubtInput").value
);



socket.emit(

"customsDoubt",

{

code:myLobby,

amount

}

);



popup(
"🚨 Inspection..."
);



}







// =====================
// ERREURS
// =====================



socket.on(
"errorMessage",
msg=>{

popup(
"❌ "+msg,
"#ff4444"
);

});
