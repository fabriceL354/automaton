import React, { useState } from 'react';
import {
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { simulateFictionalScenarios } from '../../../../src/agent/fictional-simulation';

type SimulationResult = ReturnType<typeof simulateFictionalScenarios>['scenarios'][number];

const fields = [
  { key: 'budget', label: 'Budget fictif (€)' },
  { key: 'fixed', label: 'Coûts fixes (€)' },
  { key: 'cost', label: 'Coût par vente (€)' },
  { key: 'price', label: 'Prix de vente (€)' },
  { key: 'units', label: 'Nombre de ventes' },
] as const;

type FieldKey = typeof fields[number]['key'];

const initialValues: Record<FieldKey, string> = {
  budget: '1000',
  fixed: '200',
  cost: '5',
  price: '15',
  units: '50',
};

function parseCents(value: string): number | null {
  const normalized = value.trim().replace(',', '.');
  if (!/^\d+(?:\.\d{1,2})?$/.test(normalized)) return null;
  const [whole, decimal = ''] = normalized.split('.');
  const cents = Number(whole) * 100 + Number(decimal.padEnd(2, '0'));
  return Number.isSafeInteger(cents) ? cents : null;
}

function formatEuros(cents: number): string {
  return (cents / 100).toFixed(2).replace('.', ',') + ' €';
}

export default function SimulationsScreen() {
  const [values, setValues] = useState(initialValues);
  const [result, setResult] = useState<SimulationResult | null>(null);

  function calculate() {
    setResult(null);

    const budget = parseCents(values.budget);
    const fixed = parseCents(values.fixed);
    const cost = parseCents(values.cost);
    const price = parseCents(values.price);
    const unitsText = values.units.trim();
    const units = /^\d+$/.test(unitsText) ? Number(unitsText) : NaN;

    if (
      budget === null || fixed === null || cost === null ||
      price === null || !Number.isSafeInteger(units)
    ) {
      Alert.alert('Saisie invalide', 'Utilise des montants positifs avec deux décimales maximum et un nombre entier de ventes.');
      return;
    }

    try {
      const report = simulateFictionalScenarios({
        version: '14.1',
        kind: 'FICTIONAL_SIMULATION',
        currency: 'EUR',
        scenarios: [{
          scenario_id: 'scenario-1',
          budget_cents: budget,
          fixed_cost_cents: fixed,
          unit_cost_cents: cost,
          unit_price_cents: price,
          units,
        }],
      });

      setResult(report.scenarios[0] ?? null);
    } catch {
      Alert.alert('Simulation refusée', 'Les valeurs dépassent les limites autorisées par le calculateur.');
    }
  }

  return (
    <ScrollView contentContainerStyle={styles.container} keyboardShouldPersistTaps="handled">
      <Text style={styles.title}>Simulations économiques</Text>
      <Text style={styles.description}>
        Calculateur V14.1 — hypothèses entièrement fictives.
      </Text>

      <View style={styles.card}>
        <Text style={styles.heading}>Scénario 1</Text>

        {fields.map(field => (
          <View key={field.key} style={styles.field}>
            <Text style={styles.label}>{field.label}</Text>
            <TextInput
              style={styles.input}
              value={values[field.key]}
              onChangeText={text => {
                setValues(previous => ({ ...previous, [field.key]: text }));
                setResult(null);
              }}
              keyboardType="decimal-pad"
              placeholder="0"
              placeholderTextColor="#8893A4"
            />
          </View>
        ))}

        <Pressable style={styles.button} onPress={calculate}>
          <Text style={styles.buttonText}>Calculer</Text>
        </Pressable>
      </View>

      {result && (
        <View style={styles.card}>
          <Text style={styles.heading}>Résultat fictif</Text>
          <Text style={styles.line}>Chiffre d'affaires : {formatEuros(result.hypothetical_revenue_cents)}</Text>
          <Text style={styles.line}>Coût total : {formatEuros(result.hypothetical_total_cost_cents)}</Text>
          <Text style={styles.line}>Résultat net simplifié : {formatEuros(result.hypothetical_net_result_cents)}</Text>
          <Text style={styles.line}>
            Seuil de rentabilité : {result.break_even.units === null ? 'Non calculable' : `${result.break_even.units} ventes`}
          </Text>
          <Text style={styles.line}>
            Budget dépassé : {result.exceeds_fictional_budget ? 'Oui' : 'Non'}
          </Text>
        </View>
      )}

      <Text style={styles.warning}>
        Simulation fictive uniquement. Aucun revenu réel garanti.
        Aucun paiement, achat ou action commerciale.
        Calcul simplifié sans taxes ni financement.
      </Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { padding: 16, gap: 14 },
  title: { fontSize: 22, fontWeight: 'bold', color: '#FFFFFF' },
  description: { color: '#D1D5DB', fontSize: 14 },
  card: { padding: 16, borderRadius: 12, backgroundColor: '#1F2937', gap: 12 },
  heading: { color: '#FFFFFF', fontWeight: 'bold', fontSize: 17 },
  field: { gap: 5 },
  label: { color: '#E5E7EB', fontSize: 14 },
  input: {
    backgroundColor: '#FFFFFF',
    color: '#111827',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 16,
  },
  button: { backgroundColor: '#2563EB', borderRadius: 8, padding: 13, alignItems: 'center' },
  buttonText: { color: '#FFFFFF', fontWeight: 'bold', fontSize: 16 },
  line: { color: '#FFFFFF', fontSize: 14 },
  warning: { color: '#FBBF24', fontSize: 13 },
});
