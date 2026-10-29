import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { ImportedPreview } from '../domain/mobileResearchImport';
import { RESEARCH_ECONOMIC_WARNING } from '../../../../src/agent/research-data-boundary';

export default function ResearchPreviewCards({ preview }: { preview: ImportedPreview }) {
  return (
    <>
      <Text style={s.note}>Statut du résultat : {preview.status}</Text>
      <Text style={s.warning}>{RESEARCH_ECONOMIC_WARNING}</Text>
      {preview.cards.length === 0 && (
        <Text style={s.note}>Aucune opportunité à afficher.</Text>
      )}
      {preview.cards.map((item, index) => (
        <View key={index} style={s.result}>
          <Text style={s.title}>{item.name}</Text>
          <Text style={s.note}>
            Coût : {item.cost_cents === null
              ? 'Inconnu' : (item.cost_cents / 100).toFixed(2) + ' €'}
          </Text>
          <Text style={s.note}>Base du coût : {item.cost_basis}</Text>
          <Text style={s.note}>Source déclarée : {item.source_url}</Text>
          <Text style={s.note}>Citation : {item.source_quote}</Text>
          <Text style={s.warning}>
            Citation concordante dans les données reçues.
            Source non authentifiée. Aucune exécution ni dépense autorisée.
          </Text>
        </View>
      ))}
    </>
  );
}

const s = StyleSheet.create({
  note: { color: '#a8b4c7', marginBottom: 12, lineHeight: 21 },
  title: { color: '#ffffff', fontWeight: 'bold', fontSize: 18, marginBottom: 12 },
  result: { borderTopWidth: 1, borderTopColor: '#475569', marginTop: 16, paddingTop: 16 },
  warning: { color: '#fbbf24', marginTop: 10, lineHeight: 20 }
});
