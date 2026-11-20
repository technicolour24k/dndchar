<script lang="ts">let { data, form }=$props();</script>
<section class="page-head"><div><p class="eyebrow">Combat</p><h1>Encounters</h1></div><form method="POST" action="?/create" class="inline"><input name="name" placeholder="Encounter name" required /><button>Create</button></form></section>
{#if form?.error}<p class="form-error">{form.error}</p>{/if}
<div class="encounter-grid">
{#each data.encounters as encounter}
  <section class="panel stack encounter-card">
    <div class="panel-head"><div><h2>{encounter.name}</h2><span>Round {encounter.roundNumber}</span></div><form method="POST" action="?/advance"><input type="hidden" name="encounterId" value={encounter.id}/><button>Next Turn</button></form></div>
    <div class="initiative-list">
      {#each encounter.participants as participant,index}<div class:active-turn={index===encounter.currentTurnIndex}><strong>{participant.initiative}</strong><span>{participant.name}</span></div>{:else}<p class="muted">No participants.</p>{/each}
    </div>
    <form method="POST" action="?/addParticipant" class="inline participant-form"><input type="hidden" name="encounterId" value={encounter.id}/><select name="characterId">{#each data.characters as character}<option value={character.id}>{character.name}</option>{/each}</select><input name="initiative" type="number" placeholder="Initiative"/><button>Add</button></form>
  </section>
{:else}<section class="panel"><p class="muted">Create an encounter to share a round and turn clock.</p></section>{/each}
</div>
