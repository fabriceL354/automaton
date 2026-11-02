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

type Report = ReturnType<typeof simulateFictionalScenarios>;
type ScenarioResult = Report['scenarios'][number];

type FieldKey =
  | 'budget'
  | 'fixed'
  | 'cost'
  | 'price'
  | 'prudent'
  | 'central'
  | 'optimiste';

const initialValues: Record<FieldKey, string> = {
  budget: '1000',
  fixed: '200',
  cost: '5',
  price: '15',
  prudent: '10',
  central: '50',
  optimiste: '100',
};

const commonFields = [
  { key: 'budget', label: 'Budget fictif (€)' },
  { key: 'fixed', label: 'Coûts fixes (€)' },
  { key: 'cost', label: 'Coût par vente (€)' },
  { key: 'price', label: 'Prix de vente (€)' },
] as const;

const scenarios = [
  { key: 'prudent', id: 'scenario-prudent', label: 'Prudent' },
  { key: 'central', id: 'scenario-central', label: 'Intermédiaire' },
  { key: 'optimiste', id: 'scenario-optimiste', label: 'Optimiste' },
] as const;

function parseCents(value: string): number | null {
  const normalized = value.trim().replace(',', '.');
  if (!/^\d+(?:\.\d{1,2})?$/.test(normalized)) return null;

  const [whole, decimal = ''] = normalized.split('.');
  const cents = Number(whole) * 100 + Number(decimal.padEnd(2, '0'));

  return Number.isSafeInteger(cents) ? cents : null;
}

function parseUnits(value: string): number | null {
  const normalized = value.trim();

  if (!/^\d+$/.test(normalized)) return null;

  const units = Number(normalized);
  return Number.isSafeInteger(units) ? units : null;
}

function euros(cents: number): string {
  return (cents / 100).toFixed(2).replace('.', ',') + ' €';
}

export default function SimulationsScreen() {
  const [values, setValues] = useState(initialValues);
  const [results, setResults] = useState<ScenarioResult[] | null>(null);

  function update(key: FieldKey, text: string) {
    setValues(previous => ({ ...previous, [key]: text }));
    setResults(null);
  }

  function calculate() {
    setResults(null);

    const budget = parseCents(values.budget);
    const fixed = parseCents(values.fixed);
    const cost = parseCents(values.cost);
    const price = parseCents(values.price);

    const volumes = scenarios.map(item => parseUnits(values[item.key]));

    if (
      budget === null ||
      fixed === null ||
      cost === null ||
      price === null ||
      volumes.some(value => value === null)
    ) {
      Alert.alert(
        'Saisie invalide',
        'Utilise des montants positifs avec deux décimales maximum et des nombres entiers de ventes.'
      );
      return;
    }

    try {
      const report = simulateFictionalScenarios({
        version: '14.1',
        kind: 'FICTIONAL_SIMULATION',
        currency: 'EUR',
        scenarios: scenarios.map((item, index) => ({
          scenario_id: item.id,
          budget_cents: budget,
          fixed_cost_cents: fixed,
          unit_cost_cents: cost,
          unit_price_cents: price,
          units: volumes[index] as number,
        })),
      });

      setResults(report.scenarios);
    } catch {
      Alert.alert(
        'Simulation refusée',
        'Une ou plusieurs valeurs dépassent les limites autorisées par le calculateur V14.1.'
      );
    }
  }

  function renderInput(key: FieldKey, label: string) {
    return (
      <View style={styles.field} key={key}>
        <Text style={styles.label}>{label}</Text>
        <TextInput
          style={styles.input}
          value={values[key]}
          onChangeText={text => update(key, text)}
          keyboardType="decimal-pad"
          placeholder="0"
          placeholderTextColor="#8893A4"
        />
      </View>
    );
  }

  return (
    <ScrollView
      contentContainerStyle={styles.container}
      keyboardShouldPersistTaps="handled"
    >
      <Text style={styles.title}>Simulations économiques</Text>
      <Text style={styles.description}>
        Comparaison de trois scénarios fictifs avec le calculateur V14.1.
      </Text>

      <View style={styles.card}>
        <Text style={styles.heading}>Hypothèses communes</Text>
        {commonFields.map(field => renderInput(field.key, field.label))}
      </View>

      <View style={styles.card}>
        <Text style={styles.heading}>Volumes de ventes</Text>

        {scenarios.map(item =>
          renderInput(item.key, `${item.label} — nombre de ventes`)
        )}

        <Pressable style={styles.button} onPress={calculate}>
          <Text style={styles.buttonText}>Comparer les 3 scénarios</Text>
        </Pressable>
      </View>

      {results && (
        <View style={styles.card}>
          <Text style={styles.heading}>Comparaison fictive</Text>

          {scenarios.map(item => {
            const result = results.find(
              entry => entry.input.scenario_id === item.id
            );

            if (!result) return null;

            const net = result.hypothetical_net_result_cents;

            return (
              <View key={item.id} style={styles.resultCard}>
                <Text style={styles.resultHeading}>{item.label}</Text>

                <Text style={styles.line}>
                  Ventes : {result.input.units}
                </Text>

                <Text style={styles.line}>
                  Chiffre d'affaires : {euros(result.hypothetical_revenue_cents)}
                </Text>

                <Text style={styles.line}>
                  Coût total : {euros(result.hypothetical_total_cost_cents)}
                </Text>

                <Text
                  style={[
                    styles.netResult,
                    { color: net < 0 ? '#FCA5A5' : '#86EFAC' },
                  ]}
                >
                  Résultat simplifié : {net > 0 ? '+' : ''}{euros(net)}
                </Text>

                <Text style={styles.line}>
                  Seuil de rentabilité : {
                    result.break_even.units === null
                      ? 'Non calculable'
                      : `${result.break_even.units} ventes`
                  }
                </Text>

                <Text style={styles.line}>
                  Budget dépassé : {
                    result.exceeds_fictional_budget ? 'Oui' : 'Non'
                  }
                </Text>
              </View>
            );
          })}
        </View>
      )}

      <Text style={styles.warning}>
        Hypothèses fictives uniquement. Aucun revenu réel garanti.
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
  card: {
    padding: 16,
    borderRadius: 12,
    backgroundColor: '#1F2937',
    gap: 12,
  },
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
  button: {
    backgroundColor: '#2563EB',
    borderRadius: 8,
    padding: 13,
    alignItems: 'center',
  },
  buttonText: {
    color: '#FFFFFF',
    fontWeight: 'bold',
    fontSize: 16,
  },
  resultCard: {
    backgroundColor: '#111827',
    borderRadius: 10,
    padding: 14,
    gap: 8,
  },
  resultHeading: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: 'bold',
  },
  line: { color: '#E5E7EB', fontSize: 14 },
  netResult: { fontSize: 16, fontWeight: 'bold' },
  warning: { color: '#FBBF24', fontSize: 13 },
});
