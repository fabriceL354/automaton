import React, { useState } from 'react';
import {
  View, Text, TextInput, Pressable, StyleSheet
} from 'react-native';

import {
  updateOpportunityDetails,
  type Opportunity
} from '../storage/opportunities';

type Props = {
  item: Opportunity;
  onSaved: () => Promise<void>;
  onCancel: () => void;
};

const statuses: {
  value: Opportunity['status'];
  label: string;
}[] = [
  { value: 'A_ETUDIER', label: 'À étudier' },
  { value: 'EN_ANALYSE', label: 'En analyse' },
  { value: 'REFUSEE', label: 'Refusée' }
];

export default function OpportunityEditor({
  item, onSaved, onCancel
}: Props) {
  const [description, setDescription] = useState(
    item.description ?? ''
  );

  const [risks, setRisks] = useState(item.risks ?? '');
  const [sources, setSources] = useState(item.sources ?? '');

  const [status, setStatus] = useState<Opportunity['status']>(
    item.status ?? 'A_ETUDIER'
  );

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  async function save() {
    if (saving) return;

    setSaving(true);
    setError('');

    try {
      await updateOpportunityDetails(
        item.id,
        description,
        risks,
        sources,
        status
      );

      await onSaved();
    } catch {
      setError('Enregistrement impossible.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <View style={styles.container}>
      <Text style={styles.heading}>Modifier la fiche</Text>

      <Text style={styles.label}>Description</Text>
      <TextInput
        style={styles.input}
        multiline
        textAlignVertical="top"
        placeholder="Décris cette opportunité"
        placeholderTextColor="#94a3b8"
        value={description}
        onChangeText={setDescription}
        maxLength={2000}
      />

      <Text style={styles.label}>Risques identifiés</Text>
      <TextInput
        style={styles.input}
        multiline
        textAlignVertical="top"
        placeholder="Quels sont les risques ?"
        placeholderTextColor="#94a3b8"
        value={risks}
        onChangeText={setRisks}
        maxLength={1000}
      />

      <Text style={styles.label}>Sources</Text>
      <TextInput
        style={styles.input}
        multiline
        textAlignVertical="top"
        placeholder="Sources à vérifier"
        placeholderTextColor="#94a3b8"
        value={sources}
        onChangeText={setSources}
        maxLength={1500}
      />

      <Text style={styles.label}>Statut</Text>

      {statuses.map(option => (
        <Pressable
          key={option.value}
          onPress={() => setStatus(option.value)}
          style={[
            styles.option,
            status === option.value && styles.selected
          ]}
        >
          <Text style={styles.text}>{option.label}</Text>
        </Pressable>
      ))}

      {error ? (
        <Text style={styles.error}>{error}</Text>
      ) : null}

      <Pressable
        style={styles.save}
        disabled={saving}
        onPress={() => { void save(); }}
      >
        <Text style={styles.saveText}>
          {saving ? 'Enregistrement...' : 'Enregistrer la fiche'}
        </Text>
      </Pressable>

      <Pressable onPress={onCancel} disabled={saving}>
        <Text style={styles.cancel}>Annuler</Text>
      </Pressable>

      <Text style={styles.info}>
        Les sources sont déclaratives et non vérifiées.
        Aucun statut n'autorise une action commerciale.
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    marginTop: 20,
    paddingTop: 15,
    borderTopWidth: 1,
    borderTopColor: '#475569'
  },
  heading: {
    color: 'white',
    fontSize: 18,
    fontWeight: 'bold',
    marginBottom: 16
  },
  label: {
    color: '#86efac',
    marginBottom: 8,
    fontWeight: 'bold'
  },
  input: {
    backgroundColor: '#101827',
    color: 'white',
    borderWidth: 1,
    borderColor: '#475569',
    borderRadius: 10,
    padding: 12,
    minHeight: 80,
    marginBottom: 16
  },
  option: {
    padding: 12,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#475569',
    marginBottom: 8
  },
  selected: {
    backgroundColor: '#166534',
    borderColor: '#4ade80'
  },
  text: {
    color: 'white'
  },
  save: {
    backgroundColor: '#166534',
    padding: 15,
    borderRadius: 10,
    alignItems: 'center',
    marginTop: 12
  },
  saveText: {
    color: 'white',
    fontWeight: 'bold'
  },
  cancel: {
    color: '#cbd5e1',
    textAlign: 'center',
    marginTop: 18
  },
  error: {
    color: '#fca5a5',
    marginTop: 12
  },
  info: {
    color: '#94a3b8',
    fontSize: 12,
    marginTop: 16
  }
});
