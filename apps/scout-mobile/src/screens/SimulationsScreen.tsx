import React from 'react';
import { simulateFictionalScenarios } from '../../../../src/agent/fictional-simulation';
import { ScrollView, StyleSheet, Text, View } from 'react-native';

export default function SimulationsScreen() {
  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Text style={styles.title}>Simulations économiques</Text>

      <Text style={styles.description}>
        Comparaison de scénarios fictifs, sans dépense ni action réelle.
      </Text>

      <View style={styles.card}>
        <Text style={styles.heading}>Scénario 1</Text>
        <Text>Petit produit numérique</Text>
        <Text>Statut : à simuler</Text>
      </View>

      <View style={styles.card}>
        <Text style={styles.heading}>Scénario 2</Text>
        <Text>Service numérique</Text>
        <Text>Statut : à simuler</Text>
      </View>

      <View style={styles.card}>
        <Text style={styles.heading}>Scénario 3</Text>
        <Text>Produit numérique spécialisé</Text>
        <Text>Statut : à simuler</Text>
      </View>

      <Text style={styles.warning}>
        Hypothèses fictives uniquement. Aucun revenu réel garanti.
      </Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { padding: 16, gap: 14 },
  title: { fontSize: 22, fontWeight: 'bold', color: '#FFFFFF' },
  description: { color: '#D1D5DB', fontSize: 14 },
  card: {
    padding: 16,
    borderRadius: 12,
    backgroundColor: '#1F2937',
    gap: 8,
  },
  heading: { color: '#FFFFFF', fontWeight: 'bold', fontSize: 17 },
  warning: { color: '#FBBF24', fontSize: 13 },
});
