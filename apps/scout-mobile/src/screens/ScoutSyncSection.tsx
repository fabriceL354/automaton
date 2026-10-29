import React, { useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { createScoutSyncSession, type SavedScoutResearch } from '../domain/scoutSyncSession';
import { scoutReceptionStore } from '../storage/scoutReception';
import { createScoutDemoV2Transport, DEMO_ENGINE_ID } from '../transport/scoutDemoV2Transport';
import ResearchPreviewCards from './ResearchPreviewCards';

const syncSession = createScoutSyncSession(scoutReceptionStore,
  { engineId: DEMO_ENGINE_ID, nowMs: Date.now },
  createScoutDemoV2Transport(scoutReceptionStore));

export default function ScoutSyncSection() {
  const [result, setResult] = useState<SavedScoutResearch | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const active = useRef(false);
  const pending = useRef(true);

  useEffect(() => {
    active.current = true;
    syncSession.load()
      .then(saved => { if (active.current) setResult(saved); })
      .catch(() => {
        if (active.current) setError('Résultat local indisponible ou non conforme.');
      })
      .finally(() => {
        pending.current = false;
        if (active.current) setBusy(false);
      });
    return () => { active.current = false; };
  }, []);

  async function receiveDemo() {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError('');
    try {
      const received = await syncSession.receive();
      if (active.current) setResult(received);
    } catch {
      if (active.current) setError(
        'Réception ou conservation refusée. Le dernier résultat conservé reste inchangé.'
      );
    } finally {
      pending.current = false;
      if (active.current) setBusy(false);
    }
  }

  return (
    <View style={s.card}>
      <Text style={s.title}>Synchronisation Scout</Text>
      <Text style={s.warning}>
        Liaison réelle non activée. Fournisseur simulé uniquement.
        Données fictives et non authentifiées. Aucune connexion réseau.
      </Text>
      <Pressable style={s.button} disabled={busy} onPress={() => { void receiveDemo(); }}>
        <Text style={s.buttonText}>
          {busy ? 'Lecture locale…' : 'Recevoir une démonstration V2'}
        </Text>
      </Pressable>
      {error ? <Text style={s.error}>{error}</Text> : null}
      {result ? (
        <>
          <Text style={s.note}>Dernier résultat conservé sur ce téléphone, consultable hors connexion.</Text>
          <Text style={s.note}>
            {result.protocol_version === 1 ? 'Démonstration V1 conservée.' :
              `Version 2 · révision ${result.revision} · ${result.data_origin === 'FICTIONAL_TEST'
                ? 'Données fictives' : 'Données déclarées, non authentifiées'}`}
          </Text>
          <Text style={s.note}>Recherche : {result.research_id}</Text>
          <Text style={s.note}>Horodatage déclaré : {result.generated_at}</Text>
          <ResearchPreviewCards preview={result.preview} />
        </>
      ) : <Text style={s.note}>Aucun résultat de démonstration conservé.</Text>}
      <Text style={s.note}>
        Stockage séparé des opportunités manuelles. Aucun projet, paiement,
        commande moteur ou autorisation commerciale.
      </Text>
    </View>
  );
}

const s = StyleSheet.create({
  card: { backgroundColor: '#1e293b', padding: 18, borderRadius: 14, marginBottom: 16 },
  title: { color: '#ffffff', fontWeight: 'bold', fontSize: 18, marginBottom: 12 },
  note: { color: '#a8b4c7', marginBottom: 12, lineHeight: 21 },
  warning: { color: '#fbbf24', marginBottom: 12, lineHeight: 21 },
  error: { color: '#fca5a5', marginBottom: 12 },
  button: { backgroundColor: '#166534', padding: 14, borderRadius: 10,
    alignItems: 'center', marginBottom: 12 },
  buttonText: { color: '#ffffff', fontWeight: 'bold' }
});
